"""Recorded citation usage audit with separate source identities and channels."""

import json

import pytest

from noticebridge import chat_collection_audit as audit
from noticebridge import chat_collection_usage_audit as usage
from noticebridge import chat_collection_usage_audit_cli as cli


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def source(source_id, texts):
    return {
        "format": "noticebridge-native-corpus-snapshot",
        "version": 1,
        "policy": audit.NATIVE_POLICY,
        "authority_verified": False,
        "sources": [{
            "role": "original",
            "sha256": source_id,
            "page_count": 1,
            "processed_pages": 1,
            "missing_pages": [],
            "limited_pages": [],
            "limited": False,
            "passages": [
                {"role": "original", "page": 1, "ordinal": i + 1, "text": text}
                for i, text in enumerate(texts)
            ],
        }],
    }


def answer(question, fragments, *, nearby=False, printed=False):
    return {
        "question": question,
        "physical_page": None,
        "kind": "passages" if fragments else "insufficient",
        "coverage": "some_text",
        "strict_match_count": 0 if nearby else len(fragments),
        "citations": [
            {"page": 1, "ordinal": ordinal, "text": text} for ordinal, text in fragments
        ],
        "context_groups": [{"page": 1, "citations": [1, 2]}] if nearby else [],
        "printed_fields": [
            {"citation": 1, "label": "Application fee", "value": "INR 500"}
        ] if printed else [],
    }


@pytest.fixture
def artifacts():
    a, b = "a" * 64, "b" * 64
    fee = "Application fee: INR 500"
    extra = "Private additional condition"
    snapshot_raw = encode({
        "format": "noticebridge-collection-native-snapshot",
        "version": 1,
        "policy": audit.SNAPSHOT_POLICY,
        "authority_verified": False,
        "sources": [source(a, [fee, extra, "Private unused"]), source(b, [fee])],
    })
    snapshot = audit.parse_snapshot(snapshot_raw)
    steps = [
        {"question": "Application fee?", "documentIds": [b, a], "includeContext": False},
        {"question": "Fee condition?", "documentIds": [a], "includeContext": True},
        {"question": "Unobtainium?", "documentIds": [b], "includeContext": False},
    ]
    question_plan = {
        "format": "noticebridge-collection-question-plan",
        "version": 1,
        "policy": audit.PLAN_POLICY,
        "source_ids": [a, b],
        "questions": steps,
    }
    entries = [
        {
            "document_id": a, "page": 1, "ordinal": ordinal,
            "text_sha256": snapshot.sources[a].fragments[(1, ordinal)].text_sha256,
            "status": status, "note": "Private personal note",
        }
        for ordinal, status in ((1, "reviewed_manually"), (3, "needs_followup"))
    ]
    review = {
        "format": "noticebridge-collection-native-review",
        "version": 1,
        "policy": audit.REVIEW_POLICY,
        "authority_verified": False,
        "source_ids": [a, b],
        "entries": entries,
    }
    quotes, counts = audit.parse_reviews(review, snapshot)
    workspace = {
        "format": "noticebridge-private-collection-workspace",
        "version": 1,
        "policy": audit.WORKSPACE_POLICY,
        "authority_verified": False,
        "source_ids": [a, b],
        "question_plan": question_plan,
        "evidence_review": review,
    }
    evidence = {
        "format": "noticebridge-collection-evidence-report",
        "version": 1,
        "policy": audit.EVIDENCE_POLICY,
        "authority_verified": False,
        "source_ids": [a, b],
        "questions": [
            {"step": steps[0], "results": [
                {"document_id": key, "parts": [answer(steps[0]["question"], [(1, fee)],
                                                     printed=True)]}
                for key in (b, a)
            ]},
            {"step": steps[1], "results": [
                {"document_id": a, "parts": [answer(steps[1]["question"],
                                                     [(1, fee), (2, extra)], nearby=True)]}
            ]},
            {"step": steps[2], "results": [
                {"document_id": b, "parts": [answer(steps[2]["question"], [])]}
            ]},
        ],
    }
    packet = {
        "format": "noticebridge-collection-review-packet",
        "version": 1,
        "policy": audit.PACKET_POLICY,
        "authority_verified": False,
        "snapshot_sha256": snapshot.sha256,
        "workspace": workspace,
        "evidence_report": evidence,
        "sources": [item.inventory() for item in snapshot.sources.values()],
        "review_counts": counts,
        "review_quotes": quotes,
    }
    packet_raw = encode(packet)
    report = usage.recompute_usage(packet, snapshot, [b, a])
    return snapshot_raw, packet_raw, report


def test_recompute_channels_and_citation_edges(artifacts):
    snapshot, packet, report = artifacts
    assert report["searches"] == 4
    assert report["unmatched"] == 1
    assert report["citations"] == 4
    assert report["distinct_citations"] == 3
    assert report["reused_fragments"] == 1
    assert report["uncited_annotations"] == 1
    first = report["rows"][0]
    assert first["turn_count"] == 2
    assert first["strict_uses"] == 1
    assert first["nearby_uses"] == 1
    assert first["annotation_status"] == "reviewed_manually"
    assert first["uses"][0]["printed_field"] is True
    assert first["uses"][1]["printed_field"] is False
    verified = usage.audit_usage(encode(report), packet, snapshot)
    assert verified["usage_recomputed"] is True
    assert verified["retrieval_replayed"] is False
    assert b"Private" not in encode(verified)
    assert b"INR 500" not in encode(verified)


@pytest.mark.parametrize("change", [
    lambda v: v.update(authority_verified=True),
    lambda v: v.update(snapshot_sha256="0" * 64),
    lambda v: v.update(citations=True),
    lambda v: v.update(reused_fragments=99),
    lambda v: v["turns"].reverse(),
    lambda v: v["rows"].reverse(),
    lambda v: v["rows"][0].update(annotation_status="unreviewed"),
    lambda v: v["rows"][0].update(turn_count=1),
    lambda v: v["rows"][0]["uses"][0].update(rank=2),
    lambda v: v["rows"][0]["uses"][0].update(channel="nearby"),
    lambda v: v["rows"][0]["uses"][0].update(printed_field=False),
    lambda v: v["rows"][0]["uses"][0].update(physical_page=1),
    lambda v: v["documents"][0].update(searches=99),
    lambda v: v["documents"][0].update(id=v["documents"][1]["id"]),
    lambda v: v.update(extra=0),
])
def test_tampered_report_rejects(artifacts, change):
    snapshot, packet, report = artifacts
    change(report)
    with pytest.raises(audit.AuditError):
        usage.audit_usage(encode(report), packet, snapshot)


def test_packet_tampering_rejects_even_with_unchanged_usage(artifacts):
    snapshot, packet_raw, report = artifacts
    packet = json.loads(packet_raw)
    packet["review_quotes"][0]["native_text"] = "forged"
    with pytest.raises(audit.AuditError):
        usage.audit_usage(encode(report), encode(packet), snapshot)


def test_cli_rejects_overwrite(artifacts, tmp_path, capsys):
    snapshot, packet, report = artifacts
    paths = [tmp_path / name for name in ("usage.json", "packet.json", "snapshot.json")]
    for path, content in zip(paths, (encode(report), packet, snapshot), strict=True):
        path.write_bytes(content)
    output = tmp_path / "audit.json"
    args = [*(str(path) for path in paths), "--output", str(output)]
    assert cli.main(args) == 0
    saved = output.read_bytes()
    assert json.loads(saved)["counts"]["citations"] == 4
    assert cli.main(args) == 2
    assert output.read_bytes() == saved
    output.unlink()
    paths[0].write_bytes(b"{}")
    assert cli.main(args) == 2
    assert not output.exists()
    assert "Native extraction and retrieval not replayed" in capsys.readouterr().out
