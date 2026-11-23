"""Exercise human label reconciliation with byte-pinned fictional test PDFs."""

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

BENCHMARKS = Path(__file__).resolve().parents[1] / "benchmarks"
sys.path.insert(0, str(BENCHMARKS))
from evaluate_labeled import evaluate_labeled  # noqa: E402
from reconcile_labeled_reviews import reconcile_reviews  # noqa: E402

PAIR = {
    "original_page": 1, "original_text": "Application deadline: 19 December 2026",
    "revised_page": 1, "revised_text": "Application deadline: 13 December 2026",
}
EXTRA_PAIR = {
    "original_page": 1, "original_text": "Registration instructions",
    "revised_page": 1, "revised_text": "Application instructions",
}


@pytest.fixture
def corpus(tmp_path, pdf_bytes):
    case = {
        "id": "fixture", "source_kind": "fictional", "label_method": "independent_human",
        "review_complete": True, "expected_pairs": [PAIR],
    }
    for role in ("original", "revised"):
        filename = f"{role}.pdf"
        data = pdf_bytes([[PAIR[f"{role}_text"]]])
        (tmp_path / filename).write_bytes(data)
        case[role] = filename
        case[f"{role}_sha256"] = hashlib.sha256(data).hexdigest()
    return case


def _save(root: Path, name: str, *cases: dict) -> Path:
    path = root / f"{name}.json"
    path.write_text(json.dumps({"version": 2, "cases": cases}), encoding="utf-8")
    return path


def _cli(first, second, *args):
    return subprocess.run(
        [sys.executable, str(BENCHMARKS / "reconcile_labeled_reviews.py"), str(first), str(second),
         "--reviewer-a", "review-a", "--reviewer-b", "review-b", *map(str, args)],
        capture_output=True, text=True, timeout=30,
    )


def test_agreement_ignores_label_order_and_uses_evaluator_normalization(tmp_path, corpus):
    a = _save(tmp_path, "a", corpus, {**corpus, "id": "no-changes", "expected_pairs": []})
    formatted = {**PAIR, "original_text": "  APPLICATION  DEADLINE: 19 December 2026"}
    b = _save(tmp_path, "b", {**corpus, "id": "no-changes", "expected_pairs": []},
              {**corpus, "expected_pairs": [formatted]})
    output = tmp_path / "resolved.json"
    result = _cli(a, b, "--output", output)
    assert result.returncode == 0, result.stderr
    audit = json.loads(result.stdout)
    assert audit["agreed_case_count"] == 2
    assert audit["positive_pair_agreement"] == 1
    assert all(len(review["sha256"]) == 64 for review in audit["review_manifests"])
    assert PAIR["original_text"] not in result.stdout

    payload = json.loads(output.read_bytes())
    assert payload["label_review"] == audit
    assert payload["cases"][0]["expected_pairs"] == [PAIR]
    report = evaluate_labeled(output)
    assert report["manifest_version"] == 2
    assert report["cases"][0]["true_positive"] == 1
    saved = output.read_bytes()
    assert _cli(a, b, "--output", output).returncode == 2
    assert output.read_bytes() == saved


def test_unresolved_review_has_counts_and_does_not_create_a_scoring_manifest(tmp_path, corpus):
    a = _save(tmp_path, "a", {**corpus, "expected_pairs": [PAIR, PAIR, EXTRA_PAIR]})
    b = _save(tmp_path, "b", corpus)
    target = tmp_path / "resolved.json"
    result = _cli(a, b, "--output", target)
    assert result.returncode == 1, result.stderr
    assert not target.exists()
    audit = json.loads(result.stdout)
    assert audit["pair_counts"] == {"both": 1, "reviewer_a_only": 2, "reviewer_b_only": 0}
    assert audit["positive_pair_agreement"] == 0.5
    assert audit["cases"][0]["resolution"] == "unresolved"
    assert "Registration instructions" not in result.stdout


def test_third_review_resolves_disagreement_and_preserves_requested_pair(tmp_path, corpus):
    a = _save(tmp_path, "a", corpus)
    b = _save(tmp_path, "b", {**corpus, "expected_pairs": []})
    final = _save(tmp_path, "decision", {**corpus, "expected_pairs": [EXTRA_PAIR]})
    target = tmp_path / "resolved.json"
    result = _cli(a, b, "--adjudication", final, "--adjudicator", "review-c", "--output", target)
    assert result.returncode == 0, result.stderr
    report = json.loads(target.read_bytes())
    assert report["cases"][0]["expected_pairs"] == [EXTRA_PAIR]
    assert report["label_review"]["cases"][0]["resolution"] == "adjudicated"
    assert report["label_review"]["adjudication_manifest"]["reviewer"] == "review-c"


def test_two_completed_negative_labels_agree_without_a_positive_pair_score(tmp_path, corpus):
    negative = {**corpus, "expected_pairs": []}
    a = _save(tmp_path, "a", negative)
    b = _save(tmp_path, "b", negative)
    audit, resolved = reconcile_reviews(a, b, reviewer_a="A", reviewer_b="B")
    assert resolved is not None
    assert audit["agreed_case_count"] == 1
    assert audit["positive_pair_agreement"] is None


@pytest.mark.parametrize(("mutation", "error"), [
    ({"review_complete": False}, "explicitly set review_complete"),
    ({"review_complete": 1}, "explicitly set review_complete"),
    ({"label_method": "synthetic"}, "declare independent_human"),
    ({"original_ocr_pages": [1]}, "reviews disagree on the source or OCR page selections"),
    ({"original_sha256": "b" * 64}, "reviews disagree on the source or OCR page selections"),
    ({"id": "other-case"}, "exact same case IDs"),
])
def test_incompatible_reviews_fail_closed(tmp_path, corpus, mutation, error):
    a = _save(tmp_path, "a", corpus)
    b = _save(tmp_path, "b", {**corpus, **mutation})
    with pytest.raises(ValueError, match=error):
        reconcile_reviews(a, b, reviewer_a="A", reviewer_b="B")


def test_stale_pdf_and_duplicate_reviewers_are_rejected(tmp_path, corpus):
    a = _save(tmp_path, "a", corpus)
    b = _save(tmp_path, "b", corpus)
    with pytest.raises(ValueError, match="different URL-safe reviewer ID"):
        reconcile_reviews(a, b, reviewer_a="Reviewer", reviewer_b="reviewer")
    with pytest.raises(ValueError, match="separate manifest"):
        reconcile_reviews(a, a, reviewer_a="A", reviewer_b="B")
    (tmp_path / "original.pdf").write_bytes(b"%PDF-1.4\n")
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        reconcile_reviews(a, b, reviewer_a="A", reviewer_b="B")


def test_adjudicator_cannot_override_agreed_or_omit_disputed_cases(tmp_path, corpus):
    agreed = {**corpus, "id": "agreed"}
    a = _save(tmp_path, "a", corpus, agreed)
    b = _save(tmp_path, "b", {**corpus, "expected_pairs": []}, agreed)
    final = _save(tmp_path, "decision", agreed)
    with pytest.raises(ValueError, match="cover exactly the cases"):
        reconcile_reviews(a, b, reviewer_a="A", reviewer_b="B",
                          adjudication_path=final, adjudicator="C")
