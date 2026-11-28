"""Independently recompute literal fragment overlap from a native snapshot.

No PDF extraction, authority verification, or semantic comparison is performed.
Only the exact text values and source coordinates already in the snapshot are used.
"""

from itertools import combinations

from .chat_collection_audit import (
    MAX_DOCUMENTS,
    MAX_PAGE,
    Snapshot,
    decode,
    digest,
    hash_string,
    integer,
    invalid,
    obj,
    parse_snapshot,
    sequence,
    strict_equal,
)

MAX_OVERLAP_BYTES = 4 * 1024 * 1024
FORMAT = "noticebridge-collection-literal-overlap"
POLICY = (
    "Exact native fragment text overlap only; not semantic equivalence, "
    "completeness or amendment."
)


def normalize_scope(value, snapshot: Snapshot) -> dict:
    row = obj(value, "documentIds minimumLength physicalPage")
    ids = [
        hash_string(source_id)
        for source_id in sequence(row["documentIds"], MAX_DOCUMENTS, minimum=2)
    ]
    if len(set(ids)) != len(ids) or any(key not in snapshot.sources for key in ids):
        invalid()
    length = integer(row["minimumLength"], 1, 900)
    page = row["physicalPage"]
    if page is not None:
        integer(page, 1, MAX_PAGE)
    return {"documentIds": ids, "minimumLength": length, "physicalPage": page}


def utf16_sort_key(text: str) -> bytes:
    """JS string comparison orders UTF-16 code units, not Unicode scalars."""
    return text.encode("utf-16-be")


def recompute_overlap(snapshot: Snapshot, scope: dict) -> dict:
    scope = normalize_scope(scope, snapshot)
    groups: dict[str, dict[str, list[dict]]] = {}
    summaries = {}
    occurrences = 0
    for source_id in scope["documentIds"]:
        source = snapshot.sources[source_id]
        distinct = set()
        count = 0
        for fragment in source.fragments.values():
            if scope["physicalPage"] is not None and fragment.page != scope["physicalPage"]:
                continue
            if len(utf16_sort_key(fragment.text)) // 2 < scope["minimumLength"]:
                continue
            by_document = groups.setdefault(fragment.text, {})
            by_document.setdefault(source_id, []).append({
                "page": fragment.page,
                "ordinal": fragment.ordinal,
            })
            distinct.add(fragment.text)
            count += 1
            occurrences += 1
        state = source.coverage(scope["physicalPage"], answer=True)
        summaries[source_id] = {
            "documentId": source_id,
            "fragments": count,
            "distinctTexts": len(distinct),
            "sharedTexts": 0,
            "exclusiveTexts": 0,
            "limited": state != "some_text",
            "coverage": state,
        }

    pairs = [
        {"left": left, "right": right, "sharedTexts": 0, "leftOnly": 0, "rightOnly": 0}
        for left, right in combinations(scope["documentIds"], 2)
    ]
    sortable = []
    shared = exclusive = 0
    for text, by_document in groups.items():
        if len(by_document) > 1:
            shared += 1
            counter = "sharedTexts"
        else:
            exclusive += 1
            counter = "exclusiveTexts"
        for source_id in by_document:
            summaries[source_id][counter] += 1
        for pair in pairs:
            left = pair["left"] in by_document
            right = pair["right"] in by_document
            if left and right:
                pair["sharedTexts"] += 1
            elif left:
                pair["leftOnly"] += 1
            elif right:
                pair["rightOnly"] += 1

        total = sum(len(rows) for rows in by_document.values())
        row = {
            "occurrences": total,
            "sources": [
                {"document_id": source_id, "fragments": rows}
                for source_id, rows in by_document.items()
            ],
        }
        sortable.append(((-len(by_document), -total, utf16_sort_key(text)), row))
    sortable.sort(key=lambda item: item[0])
    return {
        "format": FORMAT,
        "version": 1,
        "policy": POLICY,
        "authority_verified": False,
        "snapshot_sha256": snapshot.sha256,
        "scope": scope,
        "documents": list(summaries.values()),
        "pairs": pairs,
        "shared_groups": shared,
        "exclusive_groups": exclusive,
        "occurrences": occurrences,
        "groups": [row for _, row in sortable],
    }


def audit_overlap(report_raw: bytes, snapshot_raw: bytes) -> dict:
    snapshot = parse_snapshot(snapshot_raw)
    candidate = decode(report_raw, MAX_OVERLAP_BYTES)
    expected = recompute_overlap(snapshot, candidate.get("scope"))
    # Check types as well as values: Python booleans compare equal to integers.
    # Canonical browser JSON byte encoding is not asserted by this verifier.
    if not strict_equal(candidate, expected):
        invalid()
    return {
        "format": "noticebridge-collection-overlap-audit",
        "version": 1,
        "policy": "Independent literal overlap recomputation on a supplied native snapshot.",
        "authority_verified": False,
        "native_extraction_replayed": False,
        "pdf_bytes_verified": False,
        "canonical_browser_encoding_verified": False,
        "literal_overlap_recomputed": True,
        "snapshot_sha256": snapshot.sha256,
        "report_sha256": digest(report_raw),
        "scope": expected["scope"],
        "counts": {
            "documents": len(expected["documents"]),
            "pairs": len(expected["pairs"]),
            "shared_groups": expected["shared_groups"],
            "exclusive_groups": expected["exclusive_groups"],
            "occurrences": expected["occurrences"],
        },
    }
