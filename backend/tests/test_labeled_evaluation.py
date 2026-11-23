"""Labeled evaluation reports exact evidence-pair metrics, not vague accuracy."""

import hashlib
import json
import sys
from pathlib import Path

import pytest

BENCHMARK_DIR = Path(__file__).resolve().parents[1] / "benchmarks"
sys.path.insert(0, str(BENCHMARK_DIR))
from evaluate_labeled import evaluate_labeled  # noqa: E402


def _dataset(tmp_path, pdf_bytes, *, changed=True, labels=None):
    old = pdf_bytes([["Deadline: 13 December 2026"]])
    new_text = "Deadline: 14 December 2026" if changed else "Deadline: 13 December 2026"
    new = pdf_bytes([[new_text]])
    (tmp_path / "original.pdf").write_bytes(old)
    (tmp_path / "revised.pdf").write_bytes(new)
    pairs = labels if labels is not None else [{
        "original_page": 1,
        "original_text": "Deadline: 13 December 2026",
        "revised_page": 1,
        "revised_text": new_text,
    }]
    manifest = tmp_path / "labels.json"
    manifest.write_text(json.dumps({
        "version": 1,
        "cases": [{
            "id": "fictional_pair",
            "original": "original.pdf",
            "revised": "revised.pdf",
            "expected_pairs": pairs,
        }],
    }), encoding="utf-8")
    return manifest


def test_labeled_changed_pair_metrics(tmp_path, pdf_bytes):
    result = evaluate_labeled(_dataset(tmp_path, pdf_bytes))
    assert result["precision"] == 1
    assert result["recall"] == 1
    assert result["pair_counts"] == {
        "true_positive": 1,
        "false_positive": 0,
        "false_negative": 0,
        "unsupported_confirmed_changes": 0,
    }
    assert result["incomplete_case_count"] == 0
    assert result["dataset"] == "operator-supplied labels; not independently verified"


def test_false_positive_is_visible_and_does_not_invent_recall(tmp_path, pdf_bytes):
    result = evaluate_labeled(_dataset(tmp_path, pdf_bytes, labels=[]))
    assert result["pair_counts"]["false_positive"] == 1
    assert result["pair_counts"]["unsupported_confirmed_changes"] == 1
    assert result["precision"] == 0
    assert result["recall"] is None


def test_no_predictions_and_no_gold_has_undefined_metrics(tmp_path, pdf_bytes):
    result = evaluate_labeled(_dataset(tmp_path, pdf_bytes, changed=False, labels=[]))
    assert result["pair_counts"]["true_positive"] == 0
    assert result["precision"] is None
    assert result["recall"] is None


def test_duplicate_labeled_occurrences_not_collapsed(tmp_path, pdf_bytes):
    pair = {
        "original_page": 1,
        "original_text": "Deadline: 13 December 2026",
        "revised_page": 1,
        "revised_text": "Deadline: 14 December 2026",
    }
    result = evaluate_labeled(_dataset(tmp_path, pdf_bytes, labels=[pair, pair]))
    assert result["pair_counts"]["true_positive"] == 1
    assert result["pair_counts"]["false_negative"] == 1
    assert result["recall"] == 0.5


@pytest.mark.parametrize("file_path", [
    "../outside.pdf", "/tmp/outside.pdf", "notice.txt",
    r"C:\\private\\outside.pdf", r"..\\outside.pdf",
    r"\\\\server\\share\\outside.pdf",
])
def test_manifest_does_not_read_outside_or_non_pdf_files(
    tmp_path, pdf_bytes, file_path
):
    manifest = _dataset(tmp_path, pdf_bytes)
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["cases"][0]["original"] = file_path
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="relative .pdf"):
        evaluate_labeled(manifest)


def test_symlink_outside_dataset_is_rejected(tmp_path, pdf_bytes):
    manifest = _dataset(tmp_path, pdf_bytes)
    outsider = tmp_path.parent / "outside-fixture.pdf"
    outsider.write_bytes(pdf_bytes([["Outside"]]))
    try:
        (tmp_path / "linked.pdf").symlink_to(outsider)
    except OSError:
        pytest.skip("Windows test account cannot create symlinks")
    payload = json.loads(manifest.read_text())
    payload["cases"][0]["original"] = "linked.pdf"
    manifest.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="escapes"):
        evaluate_labeled(manifest)


def test_incomplete_gold_pair_and_duplicate_case_ids_are_rejected(tmp_path, pdf_bytes):
    manifest = _dataset(tmp_path, pdf_bytes)
    payload = json.loads(manifest.read_text())
    payload["cases"][0]["expected_pairs"] = [{"original_page": 1}]
    manifest.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="incomplete"):
        evaluate_labeled(manifest)

    payload["cases"][0]["expected_pairs"] = []
    payload["cases"].append(dict(payload["cases"][0]))
    manifest.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="unique"):
        evaluate_labeled(manifest)


def test_labeled_evaluation_never_uses_ollama(monkeypatch, tmp_path, pdf_bytes):
    import evaluate_labeled as module

    runner = module.run_isolated_comparison

    def capture(*args, **kwargs):
        assert kwargs["enable_semantic"] is False
        return runner(*args, **kwargs)

    monkeypatch.setattr(module, "run_isolated_comparison", capture)
    result = evaluate_labeled(_dataset(tmp_path, pdf_bytes))
    assert result["case_count"] == 1


def _v2_manifest(manifest, *, source_kind="fictional", label_method="author_reviewed"):
    root = manifest.parent
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["version"] = 2
    for case in payload["cases"]:
        case["original_sha256"] = hashlib.sha256(
            (root / case["original"]).read_bytes()
        ).hexdigest()
        case["revised_sha256"] = hashlib.sha256(
            (root / case["revised"]).read_bytes()
        ).hexdigest()
        case["source_kind"] = source_kind
        case["label_method"] = label_method
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    return manifest


def test_pinned_v2_corpus_preserves_metrics_and_provenance(tmp_path, pdf_bytes):
    manifest = _v2_manifest(_dataset(tmp_path, pdf_bytes))
    report = evaluate_labeled(manifest)
    assert report["manifest_version"] == 2
    assert len(report["manifest_sha256"]) == 64
    assert report["source_kind_case_counts"] == {"fictional": 1}
    assert report["label_method_case_counts"] == {"author_reviewed": 1}
    assert report["cases"][0]["source_kind"] == "fictional"
    assert report["precision"] == report["recall"] == 1


def test_pinned_v2_corpus_fails_if_pdf_bytes_are_modified(tmp_path, pdf_bytes):
    manifest = _v2_manifest(_dataset(tmp_path, pdf_bytes))
    (tmp_path / "original.pdf").write_bytes(
        pdf_bytes([["Deadline: 11 December 2026"]])
    )
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        evaluate_labeled(manifest)


def test_semantically_equal_manifest_has_stable_fingerprint(tmp_path, pdf_bytes):
    manifest = _v2_manifest(_dataset(tmp_path, pdf_bytes))
    first = evaluate_labeled(manifest)["manifest_sha256"]
    data = json.loads(manifest.read_text(encoding="utf-8"))
    manifest.write_text(json.dumps(data, sort_keys=True, indent=5), encoding="utf-8")
    second = evaluate_labeled(manifest)["manifest_sha256"]
    assert first == second


@pytest.mark.parametrize(("mutation", "error"), [
    ({"original_sha256": "abc"}, "original_sha256"),
    ({"revised_sha256": "F" * 64}, "revised_sha256"),
    ({"source_kind": "unknown"}, "source_kind"),
    ({"label_method": "generated_by_ai"}, "label_method"),
    ({"label_method": []}, "label_method"),
])
def test_v2_bad_source_metadata_is_rejected(
    tmp_path, pdf_bytes, mutation, error
):
    manifest = _v2_manifest(_dataset(tmp_path, pdf_bytes))
    data = json.loads(manifest.read_text(encoding="utf-8"))
    data["cases"][0].update(mutation)
    manifest.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match=error):
        evaluate_labeled(manifest)


def test_explicit_pinned_source_gate_rejects_v1(tmp_path, pdf_bytes, monkeypatch):
    from evaluate_labeled import main

    manifest = _dataset(tmp_path, pdf_bytes)
    monkeypatch.setattr(
        sys, "argv", ["evaluate_labeled", str(manifest), "--require-pinned-sources"]
    )
    with pytest.raises(SystemExit) as error:
        main()
    assert error.value.code == 2


def test_legacy_v1_still_available_but_unpinned(tmp_path, pdf_bytes):
    manifest = _dataset(tmp_path, pdf_bytes)
    report = evaluate_labeled(manifest)
    assert report["manifest_version"] == 1
    assert report["source_kind_case_counts"] == {"unrecorded": 1}
    assert report["label_method_case_counts"] == {"unrecorded": 1}

