"""Native quote audits flag mismatches without exposing review text or predictions."""

import hashlib
import json
import sys
from pathlib import Path

import pytest

BENCHMARKS = Path(__file__).resolve().parents[1] / "benchmarks"
sys.path.insert(0, str(BENCHMARKS))
from audit_review_quotes import audit_review_quotes, main  # noqa: E402

PAIR = {
    "original_page": 1, "original_text": "Deadline: 13 December 2026",
    "revised_page": 1, "revised_text": "Deadline: 14 December 2026",
}


@pytest.fixture
def dataset(tmp_path, pdf_bytes):
    case = {
        "id": "fixture", "source_kind": "fictional", "label_method": "independent_human",
        "review_complete": True, "expected_pairs": [PAIR],
    }
    for role in ("original", "revised"):
        name = f"{role}.pdf"
        content = pdf_bytes([[PAIR[f"{role}_text"]], ["Other page"]])
        (tmp_path / name).write_bytes(content)
        case[role] = name
        case[f"{role}_sha256"] = hashlib.sha256(content).hexdigest()
    path = tmp_path / "labels.json"
    path.write_text(json.dumps({"version": 2, "cases": [case]}), encoding="utf-8")
    return path


def _mutate(path, change):
    payload = json.loads(path.read_bytes())
    change(payload["cases"][0])
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_exact_native_lines_pass_without_echoing_quotes(dataset, capsys):
    report = audit_review_quotes(dataset)
    assert report["endpoint_counts"] == {"native_exact": 2}
    assert report["all_labeled_endpoints_native_exact"] is True
    assert main([str(dataset), "--require-native-exact"]) == 0
    raw = capsys.readouterr().out
    assert json.loads(raw)["labeled_endpoint_count"] == 2
    assert "Deadline:" not in raw


@pytest.mark.parametrize(("change", "status"), [
    ({"original_text": "Invented quotation"}, "native_quote_not_found"),
    ({"original_page": 2}, "native_quote_not_found"),
    ({"original_page": 3}, "page_out_of_bounds"),
    ({"original_text": "Deadline:"}, "native_quote_not_found"),
])
def test_wrong_page_or_nonexact_quote_is_flagged(dataset, change, status):
    _mutate(dataset, lambda c: c["expected_pairs"][0].update(change))
    result = audit_review_quotes(dataset)
    assert result["flagged_endpoint_count"] == 1
    assert result["review_flags"][0] == {
        "case_id": "fixture", "pair_index": 1, "role": "original",
        "page": change.get("original_page", 1), "status": status,
    }
    assert result["all_labeled_endpoints_native_exact"] is False
    assert main([str(dataset), "--require-native-exact"]) == 1


def test_normalized_equivalent_quote_matches(dataset):
    _mutate(dataset, lambda c: c["expected_pairs"][0].update(
        original_text="  DEADLINE: 13   December 2026 ",
    ))
    assert audit_review_quotes(dataset)["endpoint_counts"] == {"native_exact": 2}


def test_duplicate_labels_require_matching_source_occurrences(dataset):
    _mutate(dataset, lambda c: c["expected_pairs"].append(dict(PAIR)))
    result = audit_review_quotes(dataset)
    assert result["endpoint_counts"] == {"native_exact": 2, "native_occurrence_shortfall": 2}
    assert result["review_flags"][0]["pair_index"] == 2


def test_distinct_pairs_can_reuse_one_endpoint(dataset):
    other = {**PAIR, "revised_page": 2, "revised_text": "Other page"}
    _mutate(dataset, lambda c: c["expected_pairs"].append(other))
    assert audit_review_quotes(dataset)["endpoint_counts"] == {"native_exact": 4}


def test_selected_ocr_is_not_certified_even_if_native_text_matches(dataset):
    _mutate(dataset, lambda c: c.update(original_ocr_pages=[1]))
    result = audit_review_quotes(dataset)
    assert result["endpoint_counts"] == {"native_exact": 1, "requires_visual_review": 1}


def test_zero_pairs_do_not_create_positive_evidence(dataset):
    _mutate(dataset, lambda c: c.update(expected_pairs=[]))
    result = audit_review_quotes(dataset)
    assert result["zero_pair_case_count"] == 1
    assert result["all_labeled_endpoints_native_exact"] is None
    assert main([str(dataset), "--require-native-exact"]) == 1


def test_incomplete_review_and_changed_source_fail(dataset):
    _mutate(dataset, lambda c: c.update(review_complete=False))
    with pytest.raises(ValueError, match="unfinished"):
        audit_review_quotes(dataset)
    _mutate(dataset, lambda c: c.update(review_complete=True))
    (dataset.parent / "original.pdf").write_bytes(b"changed")
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        audit_review_quotes(dataset)


def test_diagnostic_output_is_bounded(dataset):
    _mutate(dataset, lambda c: c.update(expected_pairs=[
        {**PAIR, "original_text": f"unmatched-{i}"} for i in range(120)
    ]))
    result = audit_review_quotes(dataset)
    assert result["flagged_endpoint_count"] == 120
    assert len(result["review_flags"]) == 100
    assert result["omitted_review_flag_count"] == 20
