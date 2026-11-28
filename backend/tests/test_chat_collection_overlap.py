"""Independent overlap verifier tests, with UTF-16 and source identity fixtures."""

import json

import pytest

from noticebridge import chat_collection_audit as audit
from noticebridge import chat_collection_overlap as overlap
from noticebridge import chat_collection_overlap_cli as cli


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def source(source_id, pages):
    return {
        "format": "noticebridge-native-corpus-snapshot",
        "version": 1,
        "policy": audit.NATIVE_POLICY,
        "authority_verified": False,
        "sources": [{
            "role": "original",
            "sha256": source_id,
            "page_count": len(pages),
            "processed_pages": len(pages),
            "missing_pages": [i + 1 for i, rows in enumerate(pages) if not rows],
            "limited_pages": [],
            "limited": False,
            "passages": [
                {"role": "original", "page": i + 1, "ordinal": j + 1, "text": text}
                for i, rows in enumerate(pages) for j, text in enumerate(rows)
            ],
        }],
    }


@pytest.fixture
def artifacts():
    a, b, c = ("a" * 64, "b" * 64, "c" * 64)
    raw = encode({
        "format": "noticebridge-collection-native-snapshot",
        "version": 1,
        "policy": audit.SNAPSHOT_POLICY,
        "authority_verified": False,
        "sources": [
            source(a, [["Common", "Common", "Fee 500", "𐀀", "\ue000"], ["Different page"]]),
            source(b, [["Common", "Fee 350", "Different page"], []]),
            source(c, [["Common", "fee 500", "Third"]]),
        ],
    })
    snapshot = audit.parse_snapshot(raw)
    scope = {"documentIds": [c, a, b], "minimumLength": 1, "physicalPage": None}
    return raw, snapshot, scope


def test_literal_overlap_counts_and_utf16_order(artifacts):
    raw, snapshot, scope = artifacts
    value = overlap.recompute_overlap(snapshot, scope)
    assert value["shared_groups"] == 2
    assert value["exclusive_groups"] == 6
    assert value["occurrences"] == 12
    assert value["groups"][0]["occurrences"] == 4
    assert [row["document_id"] for row in value["groups"][0]["sources"]] == (
        scope["documentIds"]
    )
    # Supplementary-plane UTF-16 starts before private-use BMP characters.
    assert value["groups"][-2]["sources"][0]["fragments"][0]["ordinal"] == 4
    assert value["groups"][-1]["sources"][0]["fragments"][0]["ordinal"] == 5
    report = overlap.audit_overlap(encode(value), raw)
    assert report["literal_overlap_recomputed"] is True
    assert report["pdf_bytes_verified"] is False
    assert report["native_extraction_replayed"] is False
    assert b"Fee 500" not in audit.encode_audit(report)


def test_scope_preserves_physical_page_and_utf16_length(artifacts):
    _, snapshot, scope = artifacts
    page = overlap.recompute_overlap(snapshot, {**scope, "physicalPage": 2})
    assert page["shared_groups"] == 0
    assert page["exclusive_groups"] == 1
    assert [row["coverage"] for row in page["documents"]] == [
        "not_present", "some_text", "no_indexed_text",
    ]
    minimum = overlap.recompute_overlap(snapshot, {**scope, "minimumLength": 2})
    assert minimum["exclusive_groups"] == 5
    assert minimum["occurrences"] == 11


@pytest.mark.parametrize("mutation", [
    lambda v: v.update(authority_verified=True),
    lambda v: v.update(shared_groups=99),
    lambda v: v.update(exclusive_groups=True),
    lambda v: v.update(snapshot_sha256="0" * 64),
    lambda v: v["groups"].reverse(),
    lambda v: v["groups"][0]["sources"][0]["fragments"][0].update(ordinal=999),
    lambda v: v["groups"][0]["sources"][0]["fragments"][0].update(page=True),
    lambda v: v["groups"][0]["sources"].reverse(),
    lambda v: v["pairs"][0].update(sharedTexts=0),
    lambda v: v["documents"][0].update(coverage="partial"),
    lambda v: v["scope"]["documentIds"].reverse(),
    lambda v: v["scope"].update(minimumLength=0),
    lambda v: v["scope"].update(physicalPage=81),
    lambda v: v["scope"].update(physicalPage=True),
    lambda v: v.update(untrusted_extra=True),
])
def test_recompute_rejects_forged_counts_source_references_and_scope(artifacts, mutation):
    raw, snapshot, scope = artifacts
    value = overlap.recompute_overlap(snapshot, scope)
    mutation(value)
    with pytest.raises(audit.AuditError):
        overlap.audit_overlap(encode(value), raw)


def test_rejects_malformed_or_duplicate_json(artifacts):
    raw, snapshot, scope = artifacts
    value = encode(overlap.recompute_overlap(snapshot, scope))
    for changed in [
        b"{}", b"\xff", b"[]",
        value.replace(b'"version": 1,', b'"version": 1, "version": 1,', 1),
    ]:
        with pytest.raises(audit.AuditError):
            overlap.audit_overlap(changed, raw)


def test_cli_atomic_output_and_no_private_text(artifacts, tmp_path, capsys):
    raw, snapshot, scope = artifacts
    source_path = tmp_path / "snapshot.json"
    report_path = tmp_path / "report.json"
    output = tmp_path / "audit.json"
    source_path.write_bytes(raw)
    report_path.write_bytes(encode(overlap.recompute_overlap(snapshot, scope)))
    args = [str(report_path), str(source_path), "--output", str(output)]
    assert cli.main(args) == 0
    saved = output.read_bytes()
    assert b"Common" not in saved
    assert json.loads(saved)["literal_overlap_recomputed"] is True
    assert cli.main(args) == 2
    assert output.read_bytes() == saved
    output.unlink()
    report_path.write_bytes(b"{}")
    assert cli.main(args) == 2
    assert not output.exists()
    assert "Native extraction and PDF bytes remain unchecked" in capsys.readouterr().out
