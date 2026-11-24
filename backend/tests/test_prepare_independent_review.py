"""Independent review preparation must not expose existing answer keys."""

import hashlib
import json
import sys
from pathlib import Path

import pytest

BENCHMARKS = Path(__file__).resolve().parents[1] / "benchmarks"
sys.path.insert(0, str(BENCHMARKS))
import evaluate_labeled  # noqa: E402
import evaluate_semantic  # noqa: E402
from prepare_independent_review import check_review, main, prepare_review  # noqa: E402

PAIR = {
    "original_page": 1, "original_text": "Deadline: 13 December 2026",
    "revised_page": 1, "revised_text": "Deadline: 14 December 2026",
}


def _save(path, payload):
    path.write_text(json.dumps(payload), encoding="utf-8")


@pytest.fixture
def source(tmp_path, pdf_bytes):
    case = {
        "id": "fixture", "source_kind": "fictional", "label_method": "author_reviewed",
        "expected_pairs": [PAIR], "review_complete": True,
        "model_predictions": ["private-answer-key"],
        "original_ocr_pages": [2, 1],
    }
    for role in ("original", "revised"):
        data = pdf_bytes([[PAIR[f"{role}_text"]], ["Second page"]])
        name = f"{role}.pdf"
        (tmp_path / name).write_bytes(data)
        case[role] = name
        case[f"{role}_sha256"] = hashlib.sha256(data).hexdigest()
    path = tmp_path / "source.json"
    _save(path, {"version": 2, "cases": [case], "label_review": "private audit"})
    return path


def test_blank_review_copies_only_source_fields(source):
    output = source.with_name("review-a.json")
    original = source.read_bytes()
    audit = prepare_review(source, output=output)
    assert audit["case_count"] == 1
    assert audit["review_complete"] is False
    assert len(audit["source_manifest_sha256"]) == 64
    payload = json.loads(output.read_bytes())
    assert set(payload) == {"version", "cases"}
    case = payload["cases"][0]
    assert set(case) == {
        "id", "original", "revised", "original_sha256", "revised_sha256", "source_kind",
        "original_ocr_pages", "label_method", "expected_pairs", "review_complete",
    }
    assert case["original_ocr_pages"] == [1, 2]
    assert case["expected_pairs"] == []
    assert case["review_complete"] is False
    assert PAIR["original_text"] not in output.read_text()
    assert "private-answer-key" not in output.read_text()
    assert source.read_bytes() == original
    before = output.read_bytes()
    with pytest.raises(FileExistsError):
        prepare_review(source, output=output)
    assert output.read_bytes() == before


@pytest.mark.parametrize("value", [False, None, 0, 1, "true"])
def test_incomplete_reviews_cannot_enter_either_evaluator(source, monkeypatch, value):
    output = source.with_name("review.json")
    prepare_review(source, output=output)
    payload = json.loads(output.read_bytes())
    payload["cases"][0]["review_complete"] = value
    _save(output, payload)

    def forbidden(*args, **kwargs):
        raise AssertionError("A review that is not complete must never invoke a worker")

    monkeypatch.setattr(evaluate_labeled, "run_isolated_comparison", forbidden)
    monkeypatch.setattr(evaluate_semantic, "run_isolated_comparison", forbidden)
    with pytest.raises(ValueError, match="unfinished review"):
        evaluate_labeled.evaluate_labeled(output)
    with pytest.raises(ValueError, match="unfinished review"):
        evaluate_semantic.evaluate_semantic(output)


@pytest.mark.parametrize("pairs", [[], [PAIR]])
def test_finished_negative_and_positive_reviews_are_distinguishable(source, pairs):
    output = source.with_name("review.json")
    prepare_review(source, output=output)
    with pytest.raises(ValueError, match="explicitly complete"):
        check_review(source, review=output)
    payload = json.loads(output.read_bytes())
    payload["cases"][0].update(expected_pairs=pairs, review_complete=True)
    _save(output, payload)
    before = output.read_bytes()
    audit = check_review(source, review=output)
    assert audit["completed_case_count"] == 1
    assert audit["zero_pair_case_count"] == int(not pairs)
    assert audit["labeled_pair_count"] == len(pairs)
    assert output.read_bytes() == before
    assert PAIR["original_text"] not in json.dumps(audit)


@pytest.mark.parametrize("mutation", [
    {"id": "other"}, {"original_sha256": "a" * 64}, {"source_kind": "consented"},
    {"original_ocr_pages": [1]}, {"label_method": "author_reviewed"},
])
def test_review_cannot_change_source_or_claim_completion_without_independence(source, mutation):
    output = source.with_name("review.json")
    prepare_review(source, output=output)
    payload = json.loads(output.read_bytes())
    payload["cases"][0].update(review_complete=True, **mutation)
    _save(output, payload)
    with pytest.raises(ValueError):
        check_review(source, review=output)


def test_changed_pdf_and_invalid_output_paths_fail_without_creating_file(source):
    target = source.with_name("review.json")
    with pytest.raises(ValueError, match="dataset folder"):
        prepare_review(source, output=source.parent / "outside" / "review.json")
    with pytest.raises(ValueError, match="JSON"):
        prepare_review(source, output=target.with_suffix(".txt"))
    (source.parent / "original.pdf").write_bytes(b"%PDF-1.4\n")
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        prepare_review(source, output=target)
    assert not target.exists()


def test_cli_creates_and_checks_without_overwriting(source, capsys):
    target = source.with_name("review.json")
    assert main([str(source), "--output", str(target)]) == 0
    assert json.loads(capsys.readouterr().out)["review_complete"] is False
    payload = json.loads(target.read_bytes())
    payload["cases"][0]["review_complete"] = True
    _save(target, payload)
    assert main([str(source), "--check", str(target)]) == 0
    assert json.loads(capsys.readouterr().out)["zero_pair_case_count"] == 1
    with pytest.raises(SystemExit) as error:
        main([str(source), "--output", str(target)])
    assert error.value.code == 2
