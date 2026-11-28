"""Independent evaluation audit: source hashes, metrics and paired variants."""

import json

import pytest

from noticebridge import chat_collection_audit as audit
from noticebridge import chat_collection_evaluation_audit as ev
from noticebridge import chat_collection_evaluation_audit_cli as cli


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
    a, b = "a" * 64, "b" * 64
    snapshot_raw = encode({
        "format": "noticebridge-collection-native-snapshot",
        "version": 1,
        "policy": audit.SNAPSHOT_POLICY,
        "authority_verified": False,
        "sources": [
            source(a, [["Private label one", "Unlabelled", "Private label two"], []]),
            source(b, [["Private negative"]]),
        ],
    })
    snapshot = audit.parse_snapshot(snapshot_raw)
    labels_raw = encode({
        "format": "noticebridge-collection-retrieval-labels",
        "version": 1,
        "policy": ev.LABEL_POLICY,
        "authority_verified": False,
        "source_ids": [a, b],
        "cases": [
            {
                "document_id": a, "question": "Application fee on page 1?",
                "include_context": False, "label": "evidence", "note": "Private note",
                "expected": [
                    {"page": 1, "ordinal": i,
                     "text_sha256": snapshot.sources[a].fragments[(1, i)].text_sha256}
                    for i in (1, 3)
                ],
            },
            {
                "document_id": b, "question": "Unobtainium?", "include_context": False,
                "label": "no_expected_match", "note": "", "expected": [],
            },
        ],
    })
    labels = ev.parse_labels(labels_raw, snapshot)
    first = ev.score(labels[0], snapshot.sources[a],
                     [{"page": 1, "ordinal": 2}, {"page": 1, "ordinal": 3}])
    second = ev.score(labels[1], snapshot.sources[b], [])
    report = {
        "format": "noticebridge-collection-retrieval-evaluation",
        "version": 1,
        "policy": ev.LABEL_POLICY,
        "authority_verified": False,
        "labels_sha256": audit.digest(labels_raw),
        "metrics": ev.summarize([first, second]),
        "observations": [first.evaluation_wire(), second.evaluation_wire()],
    }
    return snapshot_raw, labels_raw, snapshot, labels, report


def test_evaluation_recomputes_exact_arithmetic_and_coordinate_sets(artifacts):
    snapshot, labels, _, _, report = artifacts
    metrics = report["metrics"]
    assert metrics["microPrecision"] == 0.5
    assert metrics["microRecall"] == 0.5
    assert metrics["meanReciprocalRank"] == 0.5
    assert metrics["correctAbstentions"] == 1
    assert metrics["incompleteCoverageCases"] == 0
    result = ev.audit_evaluation(encode(report), labels, snapshot)
    assert result["metrics_recomputed"] is True
    assert result["retrieval_replayed"] is False
    assert result["source_coordinates_checked"] is True
    assert b"Private note" not in encode(result)
    assert b"Private label" not in encode(result)


@pytest.mark.parametrize("change", [
    lambda v: v.update(authority_verified=True),
    lambda v: v.update(labels_sha256="0" * 64),
    lambda v: v["metrics"].update(cases=True),
    lambda v: v["metrics"].update(microRecall=1),
    lambda v: v["observations"].reverse(),
    lambda v: v["observations"][0].update(coverage="partial"),
    lambda v: v["observations"][0].update(outcome="all_expected"),
    lambda v: v["observations"][0].update(correct_count=2),
    lambda v: v["observations"][0]["retrieved"][0].update(page=2),
    lambda v: v["observations"][0]["retrieved"][0].update(ordinal=3),
    lambda v: v["observations"][0]["retrieved"][0].update(page=True),
    lambda v: v["observations"][0].update(reciprocal_rank=1),
    lambda v: v.update(extra=0),
])
def test_forged_evaluation_report_rejects(artifacts, change):
    snapshot, labels, _, _, report = artifacts
    change(report)
    with pytest.raises(audit.AuditError):
        ev.audit_evaluation(encode(report), labels, snapshot)


@pytest.mark.parametrize("change", [
    lambda v: v.update(source_ids=v["source_ids"][::-1]),
    lambda v: v["cases"][0]["expected"][0].update(text_sha256="0" * 64),
    lambda v: v["cases"][0]["expected"].reverse(),
    lambda v: v["cases"][0].update(label="no_expected_match"),
    lambda v: v["cases"][1].update(include_context=1),
    lambda v: v["cases"].append(v["cases"][0]),
    lambda v: v["cases"][0].update(question="Application fee on page 2?"),
])
def test_label_structure_and_binding_rejects(artifacts, change):
    _, labels_raw, snapshot, _, _ = artifacts
    labels = json.loads(labels_raw)
    change(labels)
    with pytest.raises(audit.AuditError):
        ev.parse_labels(encode(labels), snapshot)


def make_variant(artifacts):
    _, labels_raw, snapshot, labels, _ = artifacts
    label = labels[0]
    source = snapshot.sources[label.document_id]
    a = ev.score(label, source, [{"page": 1, "ordinal": 2}, {"page": 1, "ordinal": 3}])
    b = ev.score(label, source, [{"page": 1, "ordinal": 3}, {"page": 1, "ordinal": 1}])
    return {
        "format": "noticebridge-collection-question-variants",
        "version": 1,
        "policy": ev.VARIANT_POLICY,
        "authority_verified": False,
        "equivalence_verified": False,
        "labels_sha256": audit.digest(labels_raw),
        "metrics": {"baseline": ev.summarize([a]), "alternative": ev.summarize([b])},
        "outcomes": {"improved": 1, "regressed": 0, "tradeoff": 0, "unchanged": 0},
        "changed_order": 0,
        "cases": [{
            "case_key": label.key, "alternative_question": "Application charge on page 1?",
            "alternative_context": False, "equivalence_confirmed": True,
            "outcome": "improved", "baseline": a.variant_wire(), "alternative": b.variant_wire(),
            "shared": [{"page": 1, "ordinal": 3}],
            "added": [{"page": 1, "ordinal": 1}],
            "removed": [{"page": 1, "ordinal": 2}],
            "expected_added": [{"page": 1, "ordinal": 1}], "expected_removed": [],
        }],
    }


def test_paired_variant_coordinates_and_metrics(artifacts):
    snapshot, labels, _, _, _ = artifacts
    value = make_variant(artifacts)
    result = ev.audit_evaluation(encode(value), labels, snapshot)
    assert result["outcomes"]["improved"] == 1
    assert result["metrics"]["baseline"]["microRecall"] == 0.5
    assert result["metrics"]["alternative"]["microRecall"] == 1
    assert result["equivalence_verified"] is False


@pytest.mark.parametrize("change", [
    lambda v: v.update(equivalence_verified=True),
    lambda v: v["cases"][0].update(equivalence_confirmed=False),
    lambda v: v["cases"][0].update(alternative_question="Application charge on page 2?"),
    lambda v: v["cases"][0].update(alternative_question="Application fee on page 1?"),
    lambda v: v["cases"][0].update(outcome="regressed"),
    lambda v: v["cases"][0].update(added=[]),
    lambda v: v["cases"][0]["alternative"].update(expected_found=[]),
    lambda v: v["cases"].append(v["cases"][0]),
    lambda v: v.update(changed_order=True),
    lambda v: v["outcomes"].update(improved=2),
])
def test_paired_report_rejects_tampering(artifacts, change):
    snapshot, labels, _, _, _ = artifacts
    value = make_variant(artifacts)
    change(value)
    with pytest.raises(audit.AuditError):
        ev.audit_evaluation(encode(value), labels, snapshot)


def test_cli_refuses_overwrite_and_invalid_report(artifacts, tmp_path, capsys):
    snapshot, labels, _, _, report = artifacts
    paths = [tmp_path / name for name in ("report.json", "labels.json", "snapshot.json")]
    for path, raw in zip(paths, (encode(report), labels, snapshot), strict=True):
        path.write_bytes(raw)
    output = tmp_path / "audit.json"
    args = [*(str(path) for path in paths), "--output", str(output)]
    assert cli.main(args) == 0
    saved = output.read_bytes()
    assert json.loads(saved)["metrics_recomputed"] is True
    assert cli.main(args) == 2
    assert output.read_bytes() == saved
    output.unlink()
    paths[0].write_bytes(b"{}")
    assert cli.main(args) == 2
    assert not output.exists()
    assert "retrieval and native extraction not replayed" in capsys.readouterr().out
