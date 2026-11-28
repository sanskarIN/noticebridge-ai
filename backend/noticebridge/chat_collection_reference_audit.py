"""Independent printed-reference index replay on retained native fragments.

The scanner is deliberately bounded and reproduces the documented ASCII
identifier grammar, not semantic cross-references. Python and JavaScript
may use different Unicode category versions; disagreements reject replay.
"""

import re
import unicodedata

from .chat_collection_audit import (
    JS_TRIM,
    MAX_DOCUMENTS,
    Snapshot,
    decode,
    digest,
    hash_string,
    header,
    invalid,
    obj,
    parse_snapshot,
    sequence,
    strict_equal,
)

MAX_REFERENCE_BYTES = 12 * 1024 * 1024
MAX_OCCURRENCES = 36000
FORMAT = "noticebridge-collection-reference-index"
POLICY = "Explicit native reference candidates only; not clause equivalence, completeness or authority."
KINDS = ("clause", "section", "paragraph", "rule", "article", "annexure", "schedule")
NUMERIC_KINDS = frozenset(KINDS[:5])
IDENTIFIER = (
    r"(?:[0-9]{1,4}(?:\.[0-9]{1,4}){0,5}[A-Za-z]?"
    r"(?:\([A-Za-z0-9]{1,5}\)){0,4}|[A-Za-z]{1,4}(?:-[0-9]{1,4})?)"
)
ID_PATTERN = re.compile(IDENTIFIER)
# JavaScript /iu includes the Kelvin sign and long s in ASCII case folding,
# but not Python's additional dotted/dotless I matches. Preserve offsets by
# replacing those two code points only in the matching view.
FOLD_VIEW = str.maketrans({"K": "K", "ſ": "s"})
ASCII_FOLD = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
PATTERN = re.compile(
    r"(?<![A-Za-z0-9_])(?ai:(" + "|".join(KINDS) + r"))[ \t]+("
    + IDENTIFIER + r")(?![\w(-]|\.[\w.(-])"
)


def utf16_offsets(text: str) -> list[int]:
    offsets = [0]
    for char in text:
        offsets.append(offsets[-1] + (2 if ord(char) > 0xFFFF else 1))
    return offsets


def references(text: str):
    """Yield kind, normalized identifier, exact range and leading flag."""
    offsets = utf16_offsets(text)
    for match in PATTERN.finditer(text.translate(FOLD_VIEW)):
        kind = match.group(1).lower()
        original_id = text[match.start(2):match.end(2)]
        if not ID_PATTERN.fullmatch(original_id):
            continue
        identifier = original_id.translate(ASCII_FOLD)
        if kind in NUMERIC_KINDS and not identifier[0].isdigit():
            continue
        start, end = match.span()
        yield (
            kind, identifier, offsets[start], offsets[end],
            not text[:start].strip(JS_TRIM),
        )


def recompute_reference_index(snapshot: Snapshot, selection: list[str]) -> dict:
    ids = [
        hash_string(value)
        for value in sequence(selection, MAX_DOCUMENTS, minimum=1)
    ]
    if len(set(ids)) != len(ids) or any(key not in snapshot.sources for key in ids):
        invalid()
    groups: dict[tuple[str, str], dict[str, dict]] = {}
    total = examined = 0
    limited = False
    for source_id in ids:
        for fragment in snapshot.sources[source_id].fragments.values():
            examined += 1
            for kind, identifier, start, end, leading in references(fragment.text):
                if total == MAX_OCCURRENCES:
                    limited = True
                    break
                group = groups.setdefault((kind, identifier), {})
                side = group.setdefault(source_id, {
                    "document_id": source_id, "leading": [], "inline": [],
                })
                side["leading" if leading else "inline"].append({
                    "page": fragment.page, "ordinal": fragment.ordinal,
                    "start_utf16": start, "end_utf16": end,
                })
                total += 1
            if limited:
                break
        if limited:
            break
    rows = []
    for (kind, identifier), group in sorted(
        groups.items(), key=lambda item: (KINDS.index(item[0][0]), item[0][1]),
    ):
        sides = list(group.values())
        leading = sum(len(side["leading"]) for side in sides)
        inline = sum(len(side["inline"]) for side in sides)
        rows.append({
            "kind": kind, "identifier": identifier,
            "state": "no_leading" if not leading else
            "single_leading" if leading == 1 else "multiple_leading",
            "documents": len(sides), "occurrences": leading + inline,
            "leading_count": leading, "inline_count": inline, "sides": sides,
        })
    return {
        "format": FORMAT,
        "version": 1,
        "policy": POLICY,
        "authority_verified": False,
        "pdf_bytes_verified": False,
        "reference_relationships_verified": False,
        "snapshot_sha256": snapshot.sha256,
        "source_ids": ids,
        "occurrence_budget_reached": limited,
        "examined_fragments": examined,
        "total_occurrences": total,
        "document_coverage": [
            {
                "document_id": key,
                "limited": snapshot.sources[key].limited,
                "missing_pages": list(snapshot.sources[key].missing),
                "processed_pages": snapshot.sources[key].processed_pages,
                "page_count": snapshot.sources[key].physical_pages,
            }
            for key in ids
        ],
        "groups": rows,
    }


def audit_reference_index(report_raw: bytes, snapshot_raw: bytes) -> dict:
    snapshot = parse_snapshot(snapshot_raw)
    candidate = obj(
        decode(report_raw, MAX_REFERENCE_BYTES),
        "format version policy authority_verified pdf_bytes_verified "
        "reference_relationships_verified snapshot_sha256 source_ids occurrence_budget_reached "
        "examined_fragments total_occurrences document_coverage groups",
    )
    header(candidate, FORMAT, POLICY)
    expected = recompute_reference_index(snapshot, candidate["source_ids"])
    if not strict_equal(candidate, expected):
        invalid()
    return {
        "format": "noticebridge-collection-reference-index-audit",
        "version": 1,
        "policy": "Independent printed reference and UTF-16 coordinate recomputation.",
        "authority_verified": False,
        "pdf_bytes_verified": False,
        "native_extraction_replayed": False,
        "reference_relationships_verified": False,
        "canonical_browser_encoding_verified": False,
        "reference_index_recomputed": True,
        "unicode_database_version": unicodedata.unidata_version,
        "report_sha256": digest(report_raw),
        "snapshot_sha256": snapshot.sha256,
        "source_ids": expected["source_ids"],
        "examined_fragments": expected["examined_fragments"],
        "total_occurrences": expected["total_occurrences"],
        "groups": len(expected["groups"]),
        "occurrence_budget_reached": expected["occurrence_budget_reached"],
    }
