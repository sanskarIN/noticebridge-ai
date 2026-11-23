"""Labeled evaluation reports exact evidence-pair metrics, not vague accuracy."""

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
