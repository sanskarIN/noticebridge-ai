"""Focused evidence and comparison auditing against independently checked packets."""

import json

import pytest

from noticebridge import chat_collection_audit as audit
from noticebridge import chat_collection_question_audit as question
from noticebridge import chat_collection_question_audit_cli as cli


def encode(value):
    return audit.encode_audit(value)


def source(source_id, lines):
    return {
        "format": "noticebridge-native-corpus-snapshot",
        "version": 1,
        "policy": audit.NATIVE_POLICY,
        "authority_verified": False,
        "sources": [{
            "role": "original", "sha256": source_id, "page_count": 1,
            "processed_pages": 1, "missing_pages": [], "limited_pages": [],
            "limited": False,
            "passages": [
                {"role": "original", "page": 1, "ordinal": i + 1, "text": text}
                for i, text in enumerate(lines)
            ],
        }],
    }


def part(question_text, lines, *, nearby=False, printed=False):
    return {
        "question": question_text,
        "physical_page": None,
        "coverage": "some_text",
        "kind": "passages" if lines else "insufficient",
        "strict_match_count": 0 if nearby else len(lines),
        "citations": [
            {"page": 1, "ordinal": ordinal, "text": text} for ordinal, text in lines
        ],
        "context_groups": [{"page": 1, "citations": [1, 2]}] if nearby else [],
        "printed_fields": [
            {"citation": 1, "label": "Fee", "value": "500"}
        ] if printed else [],
    }


@pytest.fixture
def artifacts():
    a, b = "a" * 64, "b" * 64
    one, two = "Fee: 500", "Private condition"
    snapshot_raw = encode({
        "format": "noticebridge-collection-native-snapshot",
        "version": 1,
        "policy": audit.SNAPSHOT_POLICY,
        "authority_verified": False,
        "sources": [source(a, [one, two]), source(b, ["Fee: 300"])],
    })
    snapshot = audit.parse_snapshot(snapshot_raw)
    steps = [
        {"question": "Fee?", "documentIds": [b, a], "includeContext": False},
        {"question": "Fee condition?", "documentIds": [a], "includeContext": True},
        {"question": "Missing?", "documentIds": [a], "includeContext": False},
    ]
    evidence = {
        "format": "noticebridge-collection-evidence-report",
        "version": 1, "policy": audit.EVIDENCE_POLICY,
        "authority_verified": False, "source_ids": [a, b],
        "questions": [
            {"step": steps[0], "results": [
                {"document_id": b, "parts": [part("Fee?", [(1, "Fee: 300")])]},
                {"document_id": a, "parts": [part("Fee?", [(1, one)], printed=True)]},
            ]},
            {"step": steps[1], "results": [
                {"document_id": a, "parts": [
                    part("Fee condition?", [(1, one), (2, two)], nearby=True),
                ]},
            ]},
            {"step": steps[2], "results": [
                {"document_id": a, "parts": [part("Missing?", [])]},
            ]},
        ],
    }
    packet = {
        "format": "noticebridge-collection-review-packet",
        "version": 1, "policy": audit.PACKET_POLICY, "authority_verified": False,
        "snapshot_sha256": snapshot.sha256,
        "workspace": {
            "format": "noticebridge-private-collection-workspace",
            "version": 1, "policy": audit.WORKSPACE_POLICY, "authority_verified": False,
            "source_ids": [a, b],
            "question_plan": {
                "format": "noticebridge-collection-question-plan",
                "version": 1, "policy": audit.PLAN_POLICY,
                "source_ids": [a, b], "questions": steps,
            },
            "evidence_review": None,
        },
        "evidence_report": evidence,
        "sources": [row.inventory() for row in snapshot.sources.values()],
        "review_counts": dict.fromkeys(audit.STATUSES, 0),
        "review_quotes": [],
    }
    packet_raw = encode(packet)
    audit.audit_packet(packet_raw, snapshot_raw)
    brief = question.recompute_brief(packet, snapshot, 0, 0)
    diff = question.recompute_difference(packet, snapshot,
                                         {"turn": 0, "part": 0}, {"turn": 1, "part": 0})
    return snapshot_raw, packet_raw, brief, diff


def test_brief_preserves_literal_and_missing_outcomes(artifacts):
    snapshot_raw, packet_raw, brief, _ = artifacts
    assert [row["outcome"] for row in brief["sources"]] == ["strict_excerpts", "literal_fields"]
    assert brief["sources"][1]["citations"][0]["text_sha256"] == audit.digest(b"Fee: 500")
    packet, snapshot = json.loads(packet_raw), audit.parse_snapshot(snapshot_raw)
    nearby = question.recompute_brief(packet, snapshot, 1, 0)
    assert nearby["sources"][0]["outcome"] == "nearby_excerpts"
    assert nearby["sources"][0]["omitted_strict_matches"] == 0
    missing = question.recompute_brief(packet, snapshot, 2, 0)
    assert missing["sources"][0]["outcome"] == "no_evidence"
    result = question.audit_question_artifact(encode(brief), packet_raw, snapshot_raw)
    assert result["counts"] == {"documents": 2, "citations": 2}
    assert result["retrieval_replayed"] is False
    assert b"Fee: 500" not in encode(result)


def test_difference_excludes_one_sided_sources_from_common_counts(artifacts):
    snapshot_raw, packet_raw, _, diff = artifacts
    assert diff["common_documents"] == 1
    assert diff["shared"] == 1
    assert diff["left_only"] == 0
    assert diff["right_only"] == 1
    assert diff["channel_changes"] == 1
    assert diff["documents"][0]["state"] == "left_only"
    assert diff["documents"][0]["left_only"] == 1
    assert diff["documents"][1]["rows"][0]["right_channel"] == "nearby"
    result = question.audit_question_artifact(encode(diff), packet_raw, snapshot_raw)
    assert result["counts"]["channel_changes"] == 1
    assert result["native_extraction_replayed"] is False


@pytest.mark.parametrize("change", [
    lambda v: v.update(authority_verified=True),
    lambda v: v.update(part_index=True),
    lambda v: v.update(part_index=9),
    lambda v: v.update(question="forged"),
    lambda v: v["sources"].reverse(),
    lambda v: v["sources"][1]["printed_fields"][0].update(value="999"),
    lambda v: v["sources"][1]["citations"][0].update(text_sha256="0" * 64),
    lambda v: v["sources"][1]["citations"][0].update(text="forged"),
    lambda v: v["sources"][1].update(omitted_strict_matches=10),
    lambda v: v["step"].update(includeContext=True),
])
def test_brief_rejects_tampering(artifacts, change):
    snapshot, packet, brief, _ = artifacts
    change(brief)
    with pytest.raises(audit.AuditError):
        question.audit_question_artifact(encode(brief), packet, snapshot)


@pytest.mark.parametrize("change", [
    lambda v: v.update(common_documents=2),
    lambda v: v.update(left_only=1),
    lambda v: v.update(same_document_set=True),
    lambda v: v["left"]["pointer"].update(turn=10),
    lambda v: v["right"].update(pointer=v["left"]["pointer"]),
    lambda v: v["documents"].reverse(),
    lambda v: v["documents"][1]["rows"][0].update(right_rank=2),
    lambda v: v["documents"][1]["rows"][0].update(right_channel="strict"),
    lambda v: v["documents"][1]["rows"][0].update(page=True),
    lambda v: v["documents"][0].update(state="both"),
])
def test_difference_rejects_tampering(artifacts, change):
    snapshot, packet, _, diff = artifacts
    change(diff)
    with pytest.raises(audit.AuditError):
        question.audit_question_artifact(encode(diff), packet, snapshot)


def test_cli_publishes_only_new_outputs(artifacts, tmp_path):
    snapshot, packet, brief, _ = artifacts
    paths = [tmp_path / name for name in ("brief.json", "packet.json", "snapshot.json")]
    for path, data in zip(paths, (encode(brief), packet, snapshot), strict=True):
        path.write_bytes(data)
    output = tmp_path / "audit.json"
    args = [*(str(path) for path in paths), "--output", str(output)]
    assert cli.main(args) == 0
    saved = output.read_bytes()
    assert cli.main(args) == 2
    assert saved == output.read_bytes()
    output.unlink()
    paths[0].write_bytes(b"{}")
    assert cli.main(args) == 2
    assert not output.exists()
