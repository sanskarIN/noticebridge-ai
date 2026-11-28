"""Audit focused evidence artifacts against a checked review packet.

The recorded retrieval is the input, not a re-execution of the ranker.
No claim about notice changes, official authority or answer truth is made.
"""

from .chat_collection_audit import (
    MAX_PACKET_BYTES,
    MAX_PARTS,
    Snapshot,
    audit_packet,
    decode,
    digest,
    header,
    integer,
    invalid,
    obj,
    parse_snapshot,
    strict_equal,
)

MAX_BRIEF_BYTES = 512 * 1024
MAX_DIFFERENCE_BYTES = 128 * 1024
BRIEF_FORMAT = "noticebridge-collection-question-brief"
BRIEF_POLICY = (
    "Private native retrieval evidence only; not a certified answer, "
    "completeness or publisher authority."
)
DIFF_FORMAT = "noticebridge-collection-question-part-difference"
DIFF_POLICY = "Comparison of displayed native retrieval only; not notice changes, relevance or authority."


def turns(packet: dict) -> list[dict]:
    evidence = packet["evidence_report"]
    if evidence is None:
        invalid()
    return evidence["questions"]


def selected_part(packet: dict, pointer: dict) -> tuple[dict, dict[str, dict]]:
    row = obj(pointer, "turn part")
    history = turns(packet)
    turn_index = integer(row["turn"], 0, len(history) - 1)
    index = integer(row["part"], 0, MAX_PARTS - 1)
    turn = history[turn_index]
    by_id = {}
    for side in turn["results"]:
        if index >= len(side["parts"]):
            invalid()
        by_id[side["document_id"]] = side["parts"][index]
    first = next(iter(by_id.values()))
    return {
        "pointer": {"turn": turn_index, "part": index},
        "question": first["question"],
        "context": turn["step"]["includeContext"],
        "page": first["physical_page"],
        "documentIds": turn["step"]["documentIds"],
        "step": turn["step"],
    }, by_id


def channel(part: dict, rank: int) -> str:
    return "nearby" if any(
        rank in group["citations"] for group in part["context_groups"]
    ) else "strict"


def brief_source(source_id: str, part: dict, snapshot: Snapshot) -> dict:
    citations = []
    for rank, item in enumerate(part["citations"], 1):
        source = snapshot.sources[source_id].source_at(item["page"], item["ordinal"])
        citations.append({
            "rank": rank,
            "page": source.page,
            "ordinal": source.ordinal,
            "text": source.text,
            "channel": channel(part, rank),
            "text_sha256": source.text_sha256,
        })
    strict = sum(row["channel"] == "strict" for row in citations)
    if part["printed_fields"]:
        outcome = "literal_fields"
    elif strict:
        outcome = "strict_excerpts"
    elif citations:
        outcome = "nearby_excerpts"
    else:
        outcome = "no_evidence"
    return {
        "document_id": source_id,
        "coverage": part["coverage"],
        "strict_matches": part["strict_match_count"],
        "displayed": len(citations),
        "omitted_strict_matches": max(0, part["strict_match_count"] - strict),
        "outcome": outcome,
        "printed_fields": part["printed_fields"],
        "context_groups": part["context_groups"],
        "citations": citations,
    }


def recompute_brief(packet: dict, snapshot: Snapshot, turn_index: int, index: int) -> dict:
    selected, sides = selected_part(packet, {"turn": turn_index, "part": index})
    return {
        "format": BRIEF_FORMAT,
        "version": 1,
        "policy": BRIEF_POLICY,
        "authority_verified": False,
        "extraction_completeness_verified": False,
        "answer_accuracy_verified": False,
        "pdf_bytes_verified": False,
        "snapshot_sha256": snapshot.sha256,
        "step": selected["step"],
        "part_index": index,
        "question": selected["question"],
        "physical_page": selected["page"],
        "sources": [
            brief_source(source_id, part, snapshot) for source_id, part in sides.items()
        ],
    }


def summary(part: dict | None) -> dict | None:
    if part is None:
        return None
    return {
        "coverage": part["coverage"],
        "strictMatches": part["strict_match_count"],
        "displayed": len(part["citations"]),
        "contextGroups": len(part["context_groups"]),
        "kind": part["kind"],
    }


def compare_source(source_id: str, left: dict | None, right: dict | None) -> dict:
    by_key = {}
    if left is not None:
        for rank, item in enumerate(left["citations"], 1):
            key = item["page"], item["ordinal"]
            by_key[key] = {
                "page": item["page"],
                "ordinal": item["ordinal"],
                "left_rank": rank,
                "right_rank": None,
                "left_channel": channel(left, rank),
                "right_channel": None,
                "state": "left_only",
            }
    if right is not None:
        for rank, item in enumerate(right["citations"], 1):
            key = item["page"], item["ordinal"]
            if key in by_key:
                by_key[key].update(
                    right_rank=rank, right_channel=channel(right, rank), state="shared",
                )
            else:
                by_key[key] = {
                    "page": item["page"],
                    "ordinal": item["ordinal"],
                    "left_rank": None,
                    "right_rank": rank,
                    "left_channel": None,
                    "right_channel": channel(right, rank),
                    "state": "right_only",
                }
    rows = list(by_key.values())
    shared = [row for row in rows if row["state"] == "shared"]
    return {
        "id": source_id,
        "left": summary(left),
        "right": summary(right),
        "state": "both" if left is not None and right is not None else
        "left_only" if left is not None else "right_only",
        "shared": len(shared),
        "left_only": sum(row["state"] == "left_only" for row in rows),
        "right_only": sum(row["state"] == "right_only" for row in rows),
        "rank_changes": sum(row["left_rank"] != row["right_rank"] for row in shared),
        "channel_changes": sum(row["left_channel"] != row["right_channel"] for row in shared),
        "rows": rows,
    }


def recompute_difference(packet: dict, snapshot: Snapshot, left: dict, right: dict) -> dict:
    a, a_sides = selected_part(packet, left)
    b, b_sides = selected_part(packet, right)
    if a["pointer"] == b["pointer"]:
        invalid()
    ids = list(dict.fromkeys([*a_sides, *b_sides]))
    documents = [
        compare_source(key, a_sides.get(key), b_sides.get(key)) for key in ids
    ]
    common = [row for row in documents if row["state"] == "both"]
    counts = {
        key: sum(row[key] for row in common)
        for key in ("shared", "left_only", "right_only", "rank_changes", "channel_changes")
    }
    return {
        "format": DIFF_FORMAT,
        "version": 1,
        "policy": DIFF_POLICY,
        "authority_verified": False,
        "snapshot_sha256": snapshot.sha256,
        "left": a,
        "right": b,
        "same_wording": a["question"] == b["question"],
        "same_physical_page": a["page"] == b["page"],
        "same_context": a["context"] == b["context"],
        "same_document_set": len(common) == len(documents),
        "common_documents": len(common),
        **counts,
        "documents": documents,
    }


def audit_question_artifact(
    report_raw: bytes, packet_raw: bytes, snapshot_raw: bytes,
) -> dict:
    checked = audit_packet(packet_raw, snapshot_raw)
    snapshot = parse_snapshot(snapshot_raw)
    packet = decode(packet_raw, MAX_PACKET_BYTES)
    candidate = decode(report_raw, MAX_BRIEF_BYTES)
    kind = candidate.get("format")
    if kind == BRIEF_FORMAT:
        header(candidate, BRIEF_FORMAT, BRIEF_POLICY)
        # A brief is independent of its original history index. Require a
        # recorded identical step rather than guessing by question text.
        matches = [
            i for i, turn in enumerate(turns(packet))
            if strict_equal(turn["step"], candidate.get("step"))
        ]
        if not matches:
            invalid()
        expected = recompute_brief(packet, snapshot, matches[0], candidate.get("part_index"))
        counts = {
            "documents": len(expected["sources"]),
            "citations": sum(row["displayed"] for row in expected["sources"]),
        }
    elif kind == DIFF_FORMAT:
        if len(report_raw) > MAX_DIFFERENCE_BYTES:
            invalid()
        header(candidate, DIFF_FORMAT, DIFF_POLICY)
        left, right = candidate.get("left"), candidate.get("right")
        if not isinstance(left, dict) or not isinstance(right, dict):
            invalid()
        expected = recompute_difference(packet, snapshot, left.get("pointer"), right.get("pointer"))
        counts = {
            "documents": len(expected["documents"]),
            **{key: expected[key] for key in (
                "common_documents", "shared", "left_only", "right_only",
                "rank_changes", "channel_changes",
            )},
        }
    else:
        invalid()
    if not strict_equal(candidate, expected):
        invalid()
    return {
        "format": "noticebridge-collection-question-artifact-audit",
        "version": 1,
        "policy": "Independent recomputation from recorded native evidence; no ranking replay.",
        "artifact_format": kind,
        "authority_verified": False,
        "native_extraction_replayed": False,
        "retrieval_replayed": False,
        "answer_accuracy_verified": False,
        "artifact_recomputed": True,
        "packet_references_consistent": checked["snapshot_references_consistent"],
        "report_sha256": digest(report_raw),
        "packet_sha256": checked["packet_sha256"],
        "snapshot_sha256": snapshot.sha256,
        "counts": counts,
    }
