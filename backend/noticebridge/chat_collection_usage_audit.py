"""Recompute citation usage from a structurally checked review packet.

This audit validates the recorded evidence edges, not the retrieval ranking
that created them. It does not open PDFs or verify publisher authority.
"""

from .chat_collection_audit import (
    MAX_DOCUMENTS,
    MAX_PACKET_BYTES,
    Snapshot,
    audit_packet,
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

MAX_USAGE_BYTES = 2 * 1024 * 1024
FORMAT = "noticebridge-collection-citation-usage"
POLICY = "Native citation reuse only; not relevance, importance, completeness or authority."


def document_summary(source_id: str) -> dict:
    return {
        "id": source_id,
        "distinctCitations": 0,
        "citations": 0,
        "annotatedCitations": 0,
        "uncitedAnnotations": 0,
        "searches": 0,
        "unmatched": 0,
    }


def row_for(source_id: str, page: int, ordinal: int, status: str | None = None) -> dict:
    return {
        "document_id": source_id,
        "page": page,
        "ordinal": ordinal,
        "annotation_status": status,
        "turn_count": 0,
        "strict_uses": 0,
        "nearby_uses": 0,
        "uses": [],
    }


def row_key(row: dict) -> tuple[str, int, int]:
    return row["document_id"], row["page"], row["ordinal"]


def recompute_usage(packet: dict, snapshot: Snapshot, document_order: list[str]) -> dict:
    if len(document_order) != len(snapshot.ids) or sorted(document_order) != snapshot.ids:
        invalid()
    summaries = {source_id: document_summary(source_id) for source_id in document_order}
    by_key = {}
    for quote in packet["review_quotes"]:
        key = row_key(quote)
        if key in by_key:
            invalid()
        by_key[key] = row_for(*key, status=quote["status"])
    evidence = packet["evidence_report"]
    questions = evidence["questions"] if evidence is not None else []
    searches = unmatched = citations = 0
    for turn_index, turn in enumerate(questions):
        for side in turn["results"]:
            source_id = side["document_id"]
            document = summaries[source_id]
            for part_index, part in enumerate(side["parts"]):
                searches += 1
                document["searches"] += 1
                sources = part["citations"]
                if not sources:
                    unmatched += 1
                    document["unmatched"] += 1
                nearby = {
                    rank for group in part["context_groups"] for rank in group["citations"]
                }
                printed = {field["citation"] for field in part["printed_fields"]}
                for rank, source in enumerate(sources, 1):
                    key = (source_id, source["page"], source["ordinal"])
                    if key not in by_key:
                        by_key[key] = row_for(*key)
                    row = by_key[key]
                    channel = "nearby" if rank in nearby else "strict"
                    row["uses"].append({
                        "turn_index": turn_index,
                        "part_index": part_index,
                        "rank": rank,
                        "physical_page": part["physical_page"],
                        "channel": channel,
                        "printed_field": rank in printed,
                    })
                    row[f"{channel}_uses"] += 1
                    document["citations"] += 1
                    citations += 1
    distinct = reused = uncited = 0
    for row in by_key.values():
        uses = row["uses"]
        row["turn_count"] = len({item["turn_index"] for item in uses})
        document = summaries[row["document_id"]]
        if uses:
            distinct += 1
            document["distinctCitations"] += 1
            if row["annotation_status"] is not None:
                document["annotatedCitations"] += 1
            if row["turn_count"] > 1:
                reused += 1
        else:
            uncited += 1
            document["uncitedAnnotations"] += 1
    rows = sorted(by_key.values(), key=lambda row: (
        -row["turn_count"], -len(row["uses"]), *row_key(row),
    ))
    return {
        "format": FORMAT,
        "version": 1,
        "policy": POLICY,
        "authority_verified": False,
        "snapshot_sha256": snapshot.sha256,
        "turns": [turn["step"] for turn in questions],
        "searches": searches,
        "unmatched": unmatched,
        "citations": citations,
        "distinct_citations": distinct,
        "reused_fragments": reused,
        "uncited_annotations": uncited,
        "documents": list(summaries.values()),
        "rows": rows,
    }


def audit_usage(report_raw: bytes, packet_raw: bytes, snapshot_raw: bytes) -> dict:
    checked = audit_packet(packet_raw, snapshot_raw)
    snapshot = parse_snapshot(snapshot_raw)
    packet = decode(packet_raw, MAX_PACKET_BYTES)
    candidate = obj(
        decode(report_raw, MAX_USAGE_BYTES),
        "format version policy authority_verified snapshot_sha256 turns searches unmatched "
        "citations distinct_citations reused_fragments uncited_annotations documents rows",
    )
    header(candidate, FORMAT, POLICY)
    if hash_string(candidate["snapshot_sha256"]) != snapshot.sha256:
        invalid()
    document_order = []
    for row in sequence(candidate["documents"], MAX_DOCUMENTS, minimum=1):
        document = obj(row, "id distinctCitations citations annotatedCitations uncitedAnnotations "
                       "searches unmatched")
        document_order.append(hash_string(document["id"]))
    expected = recompute_usage(packet, snapshot, document_order)
    if not strict_equal(candidate, expected):
        invalid()
    return {
        "format": "noticebridge-collection-citation-usage-audit",
        "version": 1,
        "policy": (
            "Independent recomputation of recorded native citation edges from a review packet."
        ),
        "authority_verified": False,
        "retrieval_replayed": False,
        "native_extraction_replayed": False,
        "canonical_browser_encoding_verified": False,
        "usage_recomputed": True,
        "packet_references_consistent": checked["snapshot_references_consistent"],
        "report_sha256": digest(report_raw),
        "packet_sha256": checked["packet_sha256"],
        "snapshot_sha256": snapshot.sha256,
        "counts": {
            "documents": len(expected["documents"]),
            "question_turns": len(expected["turns"]),
            **{key: expected[key] for key in (
                "searches", "unmatched", "citations", "distinct_citations",
                "reused_fragments", "uncited_annotations",
            )},
        },
    }
