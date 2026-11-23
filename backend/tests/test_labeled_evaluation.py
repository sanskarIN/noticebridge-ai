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
    assert result["fuzzy_matching_limited_case_count"] == 0
    assert result["confirmed_only"] == {
        "true_positive": 1, "false_positive": 0, "precision": 1, "recall": 1,
    }
    assert result["dataset"] == "operator-supplied labels; not independently verified"


def test_false_positive_is_visible_and_does_not_invent_recall(tmp_path, pdf_bytes):
    result = evaluate_labeled(_dataset(tmp_path, pdf_bytes, labels=[]))
    assert result["pair_counts"]["false_positive"] == 1
    assert result["pair_counts"]["unsupported_confirmed_changes"] == 1
    assert result["precision"] == 0
    assert result["recall"] is None
    assert result["confirmed_only"] == {
        "true_positive": 0, "false_positive": 1, "precision": 0, "recall": None,
    }


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
    import evaluate_labeled as module

    manifest = _dataset(tmp_path, pdf_bytes)

    def must_not_read(*args, **kwargs):
        pytest.fail("Legacy manifests must fail the pinned-source gate before reading PDFs")

    monkeypatch.setattr(module, "_pdf", must_not_read)
    monkeypatch.setattr(
        sys, "argv", ["evaluate_labeled", str(manifest), "--require-pinned-sources"]
    )
    with pytest.raises(SystemExit) as error:
        module.main()
    assert error.value.code == 2


@pytest.mark.parametrize(("threshold", "expected"), [("0.1667", 1), ("0.1666", 0)])
def test_recall_gate_uses_counts_before_rounding(
    tmp_path, pdf_bytes, monkeypatch, capsys, threshold, expected,
):
    from evaluate_labeled import main

    manifest = _dataset(tmp_path, pdf_bytes)
    payload = json.loads(manifest.read_text())
    payload["cases"][0]["expected_pairs"] *= 6
    manifest.write_text(json.dumps(payload))
    monkeypatch.setattr(sys, "argv", ["evaluate_labeled", str(manifest), "--min-recall", threshold])
    assert main() == expected
    assert json.loads(capsys.readouterr().out)["recall"] == 0.1667


def test_unsupported_confirmed_gate_can_fail_even_with_undefined_recall(
    tmp_path, pdf_bytes, monkeypatch, capsys,
):
    from evaluate_labeled import main

    manifest = _dataset(tmp_path, pdf_bytes, labels=[])
    monkeypatch.setattr(
        sys, "argv", ["evaluate_labeled", str(manifest), "--max-unsupported-confirmed", "0"],
    )
    assert main() == 1
    assert json.loads(capsys.readouterr().out)["confirmed_only"]["false_positive"] == 1


@pytest.mark.parametrize("role", ["original", "revised"])
def test_labeled_page_must_exist_in_its_source_pdf(tmp_path, pdf_bytes, role):
    manifest = _dataset(tmp_path, pdf_bytes)
    payload = json.loads(manifest.read_text())
    payload["cases"][0]["expected_pairs"][0][f"{role}_page"] = 2
    manifest.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match=f"outside the {role} PDF"):
        evaluate_labeled(manifest)


def test_manifest_rejects_ambiguous_duplicate_fields(tmp_path, pdf_bytes):
    manifest = _dataset(tmp_path, pdf_bytes)
    raw = manifest.read_text().replace('"version": 1', '"version": 2, "version": 1')
    manifest.write_text(raw)
    with pytest.raises(ValueError, match="duplicate field names"):
        evaluate_labeled(manifest)


def test_legacy_v1_still_available_but_unpinned(tmp_path, pdf_bytes):
    manifest = _dataset(tmp_path, pdf_bytes)
    report = evaluate_labeled(manifest)
    assert report["manifest_version"] == 1
    assert report["source_kind_case_counts"] == {"unrecorded": 1}
    assert report["label_method_case_counts"] == {"unrecorded": 1}


def test_pin_tool_preserves_independent_labels_and_detects_mutations(tmp_path, pdf_bytes):
    from pin_labeled_dataset import pin_dataset

    source = _dataset(tmp_path, pdf_bytes)
    original_labels = json.loads(source.read_text())["cases"][0]["expected_pairs"]
    output = tmp_path / "labels-pinned.json"
    result = pin_dataset(
        source, output=output, source_kind="fictional",
        label_method="author_reviewed",
    )
    assert result == output.resolve()
    pinned = json.loads(output.read_text())
    assert pinned["cases"][0]["expected_pairs"] == original_labels
    assert evaluate_labeled(output)["precision"] == 1

    (tmp_path / "revised.pdf").write_bytes(
        pdf_bytes([["Deadline: 16 December 2026"]])
    )
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        evaluate_labeled(output)


def test_pin_tool_rejects_existing_output_and_invalid_metadata(tmp_path, pdf_bytes):
    from pin_labeled_dataset import pin_dataset

    source = _dataset(tmp_path, pdf_bytes)
    output = tmp_path / "labels-pinned.json"
    options = {"source_kind": "fictional", "label_method": "synthetic"}
    pin_dataset(source, output=output, **options)
    with pytest.raises(FileExistsError):
        pin_dataset(source, output=output, **options)
    with pytest.raises(ValueError, match="explicitly declared"):
        pin_dataset(
            source, output=tmp_path / "new.json",
            source_kind="invalid", label_method="synthetic",
        )
    with pytest.raises(ValueError, match="manifest folder"):
        pin_dataset(
            source, output=tmp_path.parent / "outside.json", **options
        )


def test_pin_tool_refuses_source_file_with_parent_traversal(tmp_path, pdf_bytes):
    from pin_labeled_dataset import pin_dataset

    source = _dataset(tmp_path, pdf_bytes)
    data = json.loads(source.read_text())
    data["cases"][0]["original"] = "../secret.pdf"
    source.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="relative .pdf"):
        pin_dataset(
            source, output=tmp_path / "pinned.json",
            source_kind="fictional", label_method="synthetic",
        )
    assert not (tmp_path / "pinned.json").exists()


def test_labeled_evaluation_ocr_opt_in_is_explicit_and_never_enables_ai(
    monkeypatch, tmp_path, pdf_bytes
):
    import evaluate_labeled as module

    manifest = _v2_manifest(_dataset(tmp_path, pdf_bytes))
    real_runner = module.run_isolated_comparison
    choices = []

    def trace(*args, **kwargs):
        choices.append((kwargs["enable_ocr"], kwargs["enable_semantic"]))
        # Native-text PDFs need no actual Tesseract installation.
        kwargs["enable_ocr"] = False
        return real_runner(*args, **kwargs)

    monkeypatch.setattr(module, "run_isolated_comparison", trace)
    without = module.evaluate_labeled(manifest)
    with_ocr = module.evaluate_labeled(manifest, enable_ocr=True)
    assert choices == [(False, False), (True, False)]
    assert without["ocr_enabled"] is False
    assert with_ocr["ocr_enabled"] is True
    assert with_ocr["ocr_page_count"] == 0
    assert with_ocr["pages_without_text_count"] == 0
    assert without["pair_counts"] == with_ocr["pair_counts"]


def test_pinned_manifest_allows_baseline_and_selected_ocr_on_the_same_bytes(tmp_path, pdf_bytes):
    manifest = _dataset(tmp_path, pdf_bytes)
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["cases"][0]["original_ocr_pages"] = [1]
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    manifest = _v2_manifest(manifest)

    baseline = evaluate_labeled(manifest, require_pinned_sources=True)
    recovered = evaluate_labeled(manifest, require_pinned_sources=True, enable_ocr=True)
    assert baseline["manifest_sha256"] == recovered["manifest_sha256"]
    assert baseline["cases"][0]["selected_ocr_pages"] == {"original": [], "revised": []}
    assert baseline["confirmed_only"]["true_positive"] == 1
    assert recovered["cases"][0]["selected_ocr_pages"] == {"original": [1], "revised": []}
    assert recovered["cases"][0]["ocr_page_numbers"]["revised"] == []
    assert recovered["confirmed_only"]["true_positive"] == 0


def test_unpinned_evaluation_rejects_malformed_selected_ocr_pages(tmp_path, pdf_bytes):
    manifest = _dataset(tmp_path, pdf_bytes)
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["cases"][0]["revised_ocr_pages"] = [True]
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="invalid revised_ocr_pages"):
        evaluate_labeled(manifest)


def test_ocr_evaluation_reports_incomplete_scanned_pages_without_hallucinating(
    tmp_path, pdf_bytes
):
    import evaluate_labeled as module

    empty = pdf_bytes([[]])
    (tmp_path / "original.pdf").write_bytes(empty)
    (tmp_path / "revised.pdf").write_bytes(empty)
    payload = {
        "version": 1,
        "cases": [{
            "id": "empty_scan",
            "original": "original.pdf",
            "revised": "revised.pdf",
            "expected_pairs": [],
        }],
    }
    manifest = tmp_path / "labels.json"
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    report = module.evaluate_labeled(manifest, enable_ocr=False)
    assert report["ocr_enabled"] is False
    assert report["ocr_page_count"] == 0
    assert report["pages_without_text_count"] == 2
    assert report["incomplete_case_count"] == 1
    assert report["precision"] is None
    assert report["recall"] is None


def test_cli_forwards_ocr_flag_but_keeps_labeled_sources_local(
    tmp_path, pdf_bytes, monkeypatch, capsys
):
    import evaluate_labeled as module

    manifest = _dataset(tmp_path, pdf_bytes)
    captured = {}
    runner = module.run_isolated_comparison

    def capture(*args, **kwargs):
        captured.update(kwargs)
        return runner(*args, **kwargs)

    monkeypatch.setattr(module, "run_isolated_comparison", capture)
    monkeypatch.setattr(
        sys, "argv", ["evaluate_labeled", str(manifest), "--enable-ocr"]
    )
    assert module.main() == 0
    assert captured["enable_ocr"] is True
    assert captured["enable_semantic"] is False
    assert json.loads(capsys.readouterr().out)["ocr_enabled"] is True



def test_cohorts_separate_synthetic_success_from_declared_independent_failure(
    tmp_path, pdf_bytes,
):
    # Both fixtures are deliberately fictional: the metadata classifier must
    # report what a manifest claims without pretending to verify its source.
    manifest = _v2_manifest(
        _dataset(tmp_path, pdf_bytes), source_kind="fictional", label_method="synthetic",
    )
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    second = dict(payload["cases"][0])
    second.update({
        "id": "separately_labeled",
        "source_kind": "public_notice",
        "label_method": "independent_human",
        "expected_pairs": [],
    })
    payload["cases"].append(second)
    manifest.write_text(json.dumps(payload), encoding="utf-8")

    result = evaluate_labeled(manifest)
    assert result["case_count"] == 2
    assert result["pair_counts"] == {
        "true_positive": 1, "false_positive": 1, "false_negative": 0,
        "unsupported_confirmed_changes": 1,
    }
    assert result["precision"] == 0.5
    assert result["recall"] == 1
    groups = result["cohorts"]
    assert groups["by_source_kind"]["fictional"]["precision"] == 1
    assert groups["by_source_kind"]["public_notice"]["precision"] == 0
    assert groups["by_label_method"]["independent_human"]["recall"] is None
    assert groups["by_source_and_label_method"][
        "public_notice:independent_human"
    ]["confirmed_only"]["false_positive"] == 1
    independent = groups["declared_independent_nonfictional"]
    assert independent["case_count"] == 1
    assert independent["precision"] == 0
    assert independent["recall"] is None
    assert independent["pair_counts"]["unsupported_confirmed_changes"] == 1


def test_empty_declared_independent_cohort_keeps_metrics_undefined(tmp_path, pdf_bytes):
    manifest = _v2_manifest(_dataset(tmp_path, pdf_bytes))
    group = evaluate_labeled(manifest)["cohorts"]["declared_independent_nonfictional"]
    assert group["case_count"] == 0
    assert group["precision"] is None
    assert group["recall"] is None
    assert group["confirmed_only"]["precision"] is None
    assert group["confirmed_only"]["recall"] is None


def test_independent_corpus_gate_rejects_mixed_labels_then_accepts_declared_subset(
    tmp_path, pdf_bytes, monkeypatch, capsys,
):
    from evaluate_labeled import main

    manifest = _v2_manifest(_dataset(tmp_path, pdf_bytes))
    monkeypatch.setattr(
        sys, "argv", ["evaluate_labeled", str(manifest), "--require-independent-corpus"],
    )
    assert main() == 1
    capsys.readouterr()

    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["cases"][0]["source_kind"] = "consented"
    payload["cases"][0]["label_method"] = "independent_human"
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    assert main() == 0
    assert json.loads(capsys.readouterr().out)["cohorts"][
        "declared_independent_nonfictional"
    ]["case_count"] == 1


def test_independent_case_count_gate_and_bad_argument(
    tmp_path, pdf_bytes, monkeypatch, capsys,
):
    from evaluate_labeled import main

    manifest = _v2_manifest(
        _dataset(tmp_path, pdf_bytes),
        source_kind="public_notice", label_method="independent_human",
    )
    argv = ["evaluate_labeled", str(manifest), "--min-independent-cases", "2"]
    monkeypatch.setattr(sys, "argv", argv)
    assert main() == 1
    capsys.readouterr()
    monkeypatch.setattr(sys, "argv", argv[:-1] + ["1"])
    assert main() == 0
    capsys.readouterr()
    monkeypatch.setattr(sys, "argv", argv[:-1] + ["0"])
    with pytest.raises(SystemExit) as error:
        main()
    assert error.value.code == 2


def test_distinct_independent_pair_gate_rejects_repeated_pdf_pairs(
    tmp_path, pdf_bytes, monkeypatch, capsys,
):
    from evaluate_labeled import main

    manifest = _v2_manifest(
        _dataset(tmp_path, pdf_bytes),
        source_kind="public_notice", label_method="independent_human",
    )
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    repeat = dict(payload["cases"][0])
    repeat["id"] = "same_pdfs_different_case_id"
    payload["cases"].append(repeat)
    manifest.write_text(json.dumps(payload), encoding="utf-8")

    report = evaluate_labeled(manifest)
    cohort = report["cohorts"]["declared_independent_nonfictional"]
    assert cohort["case_count"] == 2
    assert cohort["unique_pdf_pair_count"] == 1
    assert report["cases"][0]["input_sha256"] == report["cases"][1]["input_sha256"]

    args = [
        "evaluate_labeled", str(manifest), "--require-independent-corpus",
        "--min-independent-cases", "2", "--min-independent-distinct-pairs", "2",
    ]
    monkeypatch.setattr(sys, "argv", args)
    assert main() == 1
    capsys.readouterr()

    monkeypatch.setattr(sys, "argv", args[:-1] + ["1"])
    assert main() == 0
    capsys.readouterr()
    monkeypatch.setattr(sys, "argv", args[:-1] + ["0"])
    with pytest.raises(SystemExit) as error:
        main()
    assert error.value.code == 2


def test_independent_pair_diversity_ignores_reverse_upload_order(tmp_path, pdf_bytes):
    manifest = _v2_manifest(
        _dataset(tmp_path, pdf_bytes),
        source_kind="consented", label_method="independent_human",
    )
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    reverse = dict(payload["cases"][0])
    reverse["id"] = "reverse_order"
    reverse["original"], reverse["revised"] = reverse["revised"], reverse["original"]
    reverse["original_sha256"], reverse["revised_sha256"] = (
        reverse["revised_sha256"], reverse["original_sha256"]
    )
    reverse["expected_pairs"] = []
    payload["cases"].append(reverse)
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    report = evaluate_labeled(manifest)
    assert report["cohorts"]["declared_independent_nonfictional"]["case_count"] == 2
    assert report["cohorts"]["declared_independent_nonfictional"][
        "unique_pdf_pair_count"
    ] == 1


def test_opt_in_error_examples_expose_bounded_audit_previews(tmp_path, pdf_bytes):
    manifest = _dataset(tmp_path, pdf_bytes, labels=[])
    without = evaluate_labeled(manifest)
    assert "error_examples" not in without["cases"][0]

    with_details = evaluate_labeled(manifest, include_error_examples=True)
    case = with_details["cases"][0]
    errors = case["error_examples"]
    assert errors["false_negative"] == []
    assert len(errors["false_positive"]) == 1
    assert errors["false_positive"] == errors["unsupported_confirmed"]
    example = errors["false_positive"][0]
    assert example["occurrences"] == 1
    assert (example["original_page"], example["revised_page"]) == (1, 1)
    assert example["normalized_original_preview"] == "deadline: 13 december 2026"
    assert example["normalized_revised_preview"] == "deadline: 14 december 2026"
    assert example["original_preview_truncated"] is False
    assert len(example["normalized_pair_sha256"]) == 64
    assert with_details["pair_counts"] == without["pair_counts"]


def test_error_example_cap_does_not_change_aggregate_counts():
    from collections import Counter

    from evaluate_labeled import _error_examples

    count = Counter({
        (page, "o" * 400, page, "r" * 400): 1
        for page in range(1, 20)
    })
    samples = _error_examples(count)
    assert len(samples) == 5
    assert [example["original_page"] for example in samples] == [1, 2, 3, 4, 5]
    assert all(len(example["normalized_original_preview"]) == 180 for example in samples)
    assert all(example["original_preview_truncated"] for example in samples)
    assert all(example["revised_preview_truncated"] for example in samples)
    assert sum(count.values()) == 19


def test_cli_error_examples_are_explicit_opt_in(
    tmp_path, pdf_bytes, monkeypatch, capsys,
):
    from evaluate_labeled import main

    manifest = _dataset(tmp_path, pdf_bytes, labels=[])
    monkeypatch.setattr(
        sys, "argv", ["evaluate_labeled", str(manifest), "--include-error-examples"]
    )
    assert main() == 0
    report = json.loads(capsys.readouterr().out)
    assert report["cases"][0]["error_examples"]["false_positive"]
    assert report["cases"][0]["error_examples"]["false_negative"] == []

def _mixed_accuracy_gate_manifest(tmp_path, pdf_bytes):
    """Two correct fictional cases must not mask one bad declared-independent case."""
    manifest = _v2_manifest(
        _dataset(tmp_path, pdf_bytes),
        source_kind="fictional", label_method="synthetic",
    )
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    correct = dict(payload["cases"][0])
    correct["id"] = "second_fictional"
    independent = dict(correct)
    independent.update({
        "id": "declared_independent_failure",
        "source_kind": "consented",
        "label_method": "independent_human",
        "expected_pairs": [{
            "original_page": 1,
            "original_text": "Deadline: 13 December 2026",
            "revised_page": 1,
            "revised_text": "Deadline: 25 December 2026",
        }],
    })
    payload["cases"].extend([correct, independent])
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    return manifest


@pytest.mark.parametrize(("flag", "value", "expected"), [
    ("--min-precision", "0.60", 0),
    ("--min-recall", "0.60", 0),
    ("--max-unsupported-confirmed", "1", 0),
    ("--min-independent-precision", "0.60", 1),
    ("--min-independent-recall", "0.60", 1),
    ("--max-independent-unsupported-confirmed", "0", 1),
    ("--min-independent-precision", "0", 0),
    ("--min-independent-recall", "0", 0),
    ("--max-independent-unsupported-confirmed", "1", 0),
])
def test_independent_accuracy_gates_not_diluted_by_synthetic_cases(
    tmp_path, pdf_bytes, monkeypatch, capsys, flag, value, expected,
):
    from evaluate_labeled import main

    manifest = _mixed_accuracy_gate_manifest(tmp_path, pdf_bytes)
    report = evaluate_labeled(manifest)
    assert report["precision"] == report["recall"] == 0.6667
    independent = report["cohorts"]["declared_independent_nonfictional"]
    assert independent["precision"] == independent["recall"] == 0
    assert independent["pair_counts"]["unsupported_confirmed_changes"] == 1
    monkeypatch.setattr(sys, "argv", ["evaluate_labeled", str(manifest), flag, value])
    assert main() == expected
    assert json.loads(capsys.readouterr().out)["pair_counts"]["true_positive"] == 2


@pytest.mark.parametrize(("flag", "value"), [
    ("--min-independent-precision", "0"),
    ("--min-independent-recall", "0"),
    ("--max-independent-unsupported-confirmed", "0"),
])
def test_independent_accuracy_gates_reject_empty_cohort(
    tmp_path, pdf_bytes, monkeypatch, capsys, flag, value,
):
    from evaluate_labeled import main

    manifest = _v2_manifest(_dataset(tmp_path, pdf_bytes))
    monkeypatch.setattr(sys, "argv", ["evaluate_labeled", str(manifest), flag, value])
    assert main() == 1
    assert json.loads(capsys.readouterr().out)["cohorts"][
        "declared_independent_nonfictional"
    ]["case_count"] == 0


def test_independent_recall_gate_rejects_undefined_denominator(
    tmp_path, pdf_bytes, monkeypatch, capsys,
):
    from evaluate_labeled import main

    manifest = _v2_manifest(
        _dataset(tmp_path, pdf_bytes, labels=[]),
        source_kind="public_notice", label_method="independent_human",
    )
    monkeypatch.setattr(
        sys, "argv", ["evaluate_labeled", str(manifest), "--min-independent-recall", "0"],
    )
    assert main() == 1
    assert json.loads(capsys.readouterr().out)["cohorts"][
        "declared_independent_nonfictional"
    ]["recall"] is None


@pytest.mark.parametrize(("flag", "value"), [
    ("--min-independent-precision", "-0.01"),
    ("--min-independent-recall", "1.01"),
    ("--max-independent-unsupported-confirmed", "-1"),
])
def test_independent_accuracy_thresholds_reject_invalid_inputs(
    tmp_path, pdf_bytes, monkeypatch, flag, value,
):
    from evaluate_labeled import main

    manifest = _v2_manifest(_dataset(tmp_path, pdf_bytes))
    monkeypatch.setattr(sys, "argv", ["evaluate_labeled", str(manifest), flag, value])
    with pytest.raises(SystemExit) as error:
        main()
    assert error.value.code == 2

def test_strict_independent_pair_gate_prevents_duplicate_weighting(
    tmp_path, pdf_bytes, monkeypatch, capsys,
):
    from evaluate_labeled import main

    manifest = _v2_manifest(
        _dataset(tmp_path, pdf_bytes),
        source_kind="consented", label_method="independent_human",
    )
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    repeated = dict(payload["cases"][0])
    repeated["id"] = "duplicate_inputs"
    payload["cases"].append(repeated)
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    report = evaluate_labeled(manifest)
    cohort = report["cohorts"]["declared_independent_nonfictional"]
    assert cohort["case_count"] == 2
    assert cohort["unique_pdf_pair_count"] == 1
    assert cohort["precision"] == 1  # Micro-averaging still weights repeats.

    argv = [
        "evaluate_labeled", str(manifest), "--require-distinct-independent-pairs",
    ]
    monkeypatch.setattr(sys, "argv", argv)
    assert main() == 1
    capsys.readouterr()
    # A minimum unique-pair count alone does not prohibit duplicate weighting.
    monkeypatch.setattr(sys, "argv", argv[:-1] + [
        "--min-independent-distinct-pairs", "1",
    ])
    assert main() == 0
    capsys.readouterr()
    # Duplicate files must also be rejected when original/revised are reversed.
    payload["cases"][1]["original"], payload["cases"][1]["revised"] = (
        payload["cases"][1]["revised"], payload["cases"][1]["original"]
    )
    payload["cases"][1]["original_sha256"], payload["cases"][1]["revised_sha256"] = (
        payload["cases"][1]["revised_sha256"], payload["cases"][1]["original_sha256"]
    )
    payload["cases"][1]["expected_pairs"] = []
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", argv)
    assert main() == 1
    capsys.readouterr()

    payload["cases"] = payload["cases"][:1]
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    assert main() == 0
    assert json.loads(capsys.readouterr().out)["cohorts"][
        "declared_independent_nonfictional"
    ]["unique_pdf_pair_count"] == 1

def test_strict_diversity_gate_rejects_missing_independent_cohort(
    tmp_path, pdf_bytes, monkeypatch, capsys,
):
    from evaluate_labeled import main

    manifest = _v2_manifest(_dataset(tmp_path, pdf_bytes))
    monkeypatch.setattr(
        sys, "argv",
        ["evaluate_labeled", str(manifest), "--require-distinct-independent-pairs"],
    )
    assert main() == 1
    assert json.loads(capsys.readouterr().out)["cohorts"][
        "declared_independent_nonfictional"
    ]["case_count"] == 0


def test_independent_full_coverage_gate_detects_unreadable_pages(
    tmp_path, pdf_bytes, monkeypatch, capsys,
):
    from evaluate_labeled import main

    manifest = _v2_manifest(
        _dataset(tmp_path, pdf_bytes),
        source_kind="consented", label_method="independent_human",
    )
    # The labeled deadline matches perfectly, but page 2 of each
    # document has no extractable text. Accuracy alone cannot certify coverage.
    original = pdf_bytes([["Deadline: 13 December 2026"], []])
    revised = pdf_bytes([["Deadline: 14 December 2026"], []])
    (tmp_path / "original.pdf").write_bytes(original)
    (tmp_path / "revised.pdf").write_bytes(revised)
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["cases"][0]["original_sha256"] = hashlib.sha256(original).hexdigest()
    payload["cases"][0]["revised_sha256"] = hashlib.sha256(revised).hexdigest()
    manifest.write_text(json.dumps(payload), encoding="utf-8")

    report = evaluate_labeled(manifest)
    independent = report["cohorts"]["declared_independent_nonfictional"]
    assert independent["case_count"] == 1
    assert independent["incomplete_case_count"] == 1
    assert independent["pages_without_text_count"] == 2
    assert independent["precision"] == independent["recall"] == 1

    argv = [
        "evaluate_labeled", str(manifest), "--max-independent-incomplete-cases",
    ]
    monkeypatch.setattr(sys, "argv", argv + ["0"])
    assert main() == 1
    capsys.readouterr()
    monkeypatch.setattr(sys, "argv", argv + ["1"])
    assert main() == 0
    capsys.readouterr()


def test_independent_limited_matching_gate_isolated_from_aggregate(
    tmp_path, pdf_bytes, monkeypatch, capsys,
):
    import evaluate_labeled as module

    manifest = _v2_manifest(
        _dataset(tmp_path, pdf_bytes),
        source_kind="consented", label_method="independent_human",
    )
    actual_score = module._score

    def simulated_limited_matching(*args, **kwargs):
        score = actual_score(*args, **kwargs)
        score["fuzzy_matching_limited"] = True
        return score

    monkeypatch.setattr(module, "_score", simulated_limited_matching)
    monkeypatch.setattr(
        sys, "argv",
        ["evaluate_labeled", str(manifest), "--max-independent-limited-matching-cases", "0"],
    )
    assert module.main() == 1
    result = json.loads(capsys.readouterr().out)
    assert result["cohorts"]["declared_independent_nonfictional"][
        "fuzzy_matching_limited_case_count"
    ] == 1
    assert result["precision"] == 1
    monkeypatch.setattr(
        sys, "argv",
        ["evaluate_labeled", str(manifest), "--max-independent-limited-matching-cases", "1"],
    )
    assert module.main() == 0
    capsys.readouterr()


@pytest.mark.parametrize("flag", [
    "--max-independent-incomplete-cases",
    "--max-independent-limited-matching-cases",
])
def test_independent_coverage_gates_fail_on_empty_cohort_and_invalid_arguments(
    tmp_path, pdf_bytes, monkeypatch, capsys, flag,
):
    from evaluate_labeled import main

    manifest = _v2_manifest(_dataset(tmp_path, pdf_bytes))
    monkeypatch.setattr(sys, "argv", ["evaluate_labeled", str(manifest), flag, "0"])
    assert main() == 1
    capsys.readouterr()

    monkeypatch.setattr(sys, "argv", ["evaluate_labeled", str(manifest), flag, "-1"])
    with pytest.raises(SystemExit) as exc:
        main()
    assert exc.value.code == 2
