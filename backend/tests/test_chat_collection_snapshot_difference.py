"""Independent native snapshot difference and fail-closed CLI tests."""

import json

import pytest

from noticebridge import chat_collection_audit as audit
from noticebridge import chat_collection_snapshot_difference as diff
from noticebridge import chat_collection_snapshot_difference_cli as cli


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def fragment(page, ordinal, text, x=None):
    row = {"role": "original", "page": page, "ordinal": ordinal, "text": text}
    if x is not None:
        row["position"] = {"x0": x, "x1": x + 10, "y": 20, "height": 8}
    return row


def native(source_id, fragments, limited=False):
    return {
        "format": "noticebridge-native-corpus-snapshot",
        "version": 1,
        "policy": audit.NATIVE_POLICY,
        "authority_verified": False,
        "sources": [{
            "role": "original",
            "sha256": source_id,
            "page_count": 2,
            "processed_pages": 2,
            "missing_pages": [p for p in (1, 2) if not any(
                row["page"] == p for row in fragments
            )],
            "limited_pages": [],
            "limited": limited,
            "passages": fragments,
        }],
    }


def snapshot(sources):
    return encode({
        "format": "noticebridge-collection-native-snapshot",
        "version": 1,
        "policy": audit.SNAPSHOT_POLICY,
        "authority_verified": False,
        "sources": sources,
    })


@pytest.fixture
def artifacts():
    a, b, c = "a" * 64, "b" * 64, "c" * 64
    left = snapshot([
        native(a, [
            fragment(1, 1, "same", 1),
            fragment(1, 2, "private original", 2),
            fragment(1, 3, "geometry", 3),
            fragment(1, 4, "old wording", 4),
            fragment(2, 1, "left only"),
        ]),
        native(b, [fragment(1, 1, "same")]),
    ])
    right = snapshot([
        native(a, [
            fragment(1, 1, "same", 1),
            fragment(1, 2, "private observed", 2),
            fragment(1, 3, "geometry", 9),
            fragment(1, 4, "new wording", 9),
            fragment(2, 2, "right only"),
        ], limited=True),
        native(c, [fragment(1, 1, "same")]),
    ])
    report = diff.recompute_difference(audit.parse_snapshot(left), audit.parse_snapshot(right))
    return left, right, report


def test_counts_are_disjoint_and_membership_is_source_specific(artifacts):
    left, right, report = artifacts
    assert report["counts"] == {
        "identical": 1, "text": 1, "geometry": 1,
        "text_and_geometry": 1, "left_only": 2, "right_only": 2,
    }
    assert report["same_fingerprint_set"] is False
    assert report["exact_snapshot_match"] is False
    first, second, third = report["sources"]
    assert first["coverage"]["matches"] is False
    assert first["status"] == "different"
    assert second["status"] == "left_only"
    assert third["status"] == "right_only"
    assert second["coverage"] is None
    assert first["changed_coordinates"] == [
        {"page": 1, "ordinal": 2, "kind": "text"},
        {"page": 1, "ordinal": 3, "kind": "geometry"},
        {"page": 1, "ordinal": 4, "kind": "text_and_geometry"},
        {"page": 2, "ordinal": 1, "kind": "left_only"},
        {"page": 2, "ordinal": 2, "kind": "right_only"},
    ]
    result = diff.audit_difference(encode(report), left, right)
    assert result["difference_recomputed"] is True
    assert result["pdf_bytes_verified"] is False
    assert b"private original" not in encode(result)
    assert b"private observed" not in encode(report)


def test_identical_sources_with_different_coverage_are_not_exact():
    a = "a" * 64
    left = snapshot([native(a, [fragment(1, 1, "same")])])
    right = snapshot([native(a, [fragment(1, 1, "same")], limited=True)])
    result = diff.recompute_difference(audit.parse_snapshot(left), audit.parse_snapshot(right))
    assert result["counts"]["identical"] == 1
    assert result["sources"][0]["status"] == "different"
    assert result["same_fingerprint_set"] is True
    exact = diff.recompute_difference(audit.parse_snapshot(left), audit.parse_snapshot(left))
    assert exact["exact_snapshot_match"] is True
    assert exact["sources"][0]["status"] == "identical"


@pytest.mark.parametrize("mutate", [
    lambda v: v.update(authority_verified=True),
    lambda v: v.update(pdf_bytes_verified=True),
    lambda v: v.update(extraction_completeness_verified=True),
    lambda v: v.update(exact_snapshot_match=True),
    lambda v: v.update(same_fingerprint_set=True),
    lambda v: v.update(left_sha256="0" * 64),
    lambda v: v.update(right_sha256="0" * 64),
    lambda v: v["counts"].update(identical=True),
    lambda v: v["counts"].update(text=99),
    lambda v: v["sources"].reverse(),
    lambda v: v["sources"][0].update(status="identical"),
    lambda v: v["sources"][0]["coverage"].update(matches=True),
    lambda v: v["sources"][0]["pages"][0]["counts"].update(identical=99),
    lambda v: v["sources"][0]["changed_coordinates"].reverse(),
    lambda v: v["sources"][0]["changed_coordinates"][0].update(page=True),
    lambda v: v["sources"][0]["changed_coordinates"][0].update(kind="identical"),
    lambda v: v.update(extra="not accepted"),
])
def test_forged_reports_fail(artifacts, mutate):
    left, right, report = artifacts
    mutate(report)
    with pytest.raises(audit.AuditError):
        diff.audit_difference(encode(report), left, right)


def test_exact_binding_and_duplicate_keys(artifacts):
    left, right, report = artifacts
    encoded = encode(report)
    for raw in (b"{}", b"\xff", encoded.replace(
        b'"version": 1,', b'"version": 1, "version": 1,', 1
    )):
        with pytest.raises(audit.AuditError):
            diff.audit_difference(raw, left, right)
    with pytest.raises(audit.AuditError):
        diff.audit_difference(encoded, right, left)
    with pytest.raises(audit.AuditError):
        diff.audit_difference(encoded, left, left)


def test_cli_publishes_once_and_rejects_forged_report(artifacts, tmp_path, capsys):
    left, right, report = artifacts
    paths = [tmp_path / name for name in ("report.json", "left.json", "right.json")]
    for path, raw in zip(paths, (encode(report), left, right), strict=True):
        path.write_bytes(raw)
    output = tmp_path / "audit.json"
    args = [*(str(path) for path in paths), "--output", str(output)]
    assert cli.main([*args, "--require-exact"]) == 3
    saved = output.read_bytes()
    assert json.loads(saved)["difference_recomputed"] is True
    assert cli.main(args) == 2
    assert output.read_bytes() == saved
    output.unlink()
    paths[0].write_bytes(b"{}")
    assert cli.main(args) == 2
    assert not output.exists()
    assert "PDF bytes and native extraction remain unchecked" in capsys.readouterr().out
