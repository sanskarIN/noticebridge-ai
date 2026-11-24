"""Independent generated-PDF checks for the native table conformance matrix."""

import json
import subprocess
import sys
from collections import Counter
from dataclasses import replace
from pathlib import Path

import pymupdf as fitz
import pytest

BENCHMARKS = Path(__file__).resolve().parents[1] / "benchmarks"
sys.path.insert(0, str(BENCHMARKS))
from native_table_matrix import (  # noqa: E402
    FICTIONAL_MARKER,
    HEADERS,
    MAX_CASES,
    SCENARIOS,
    check_case,
    main,
    render_pdf,
    run_matrix,
    scenario,
    validate_cases,
)


@pytest.mark.parametrize("case", SCENARIOS, ids=[case.id for case in SCENARIOS])
def test_native_table_matrix_preserves_review_safety(case):
    result = check_case(case)
    assert result["id"] == case.id
    assert result["pass"], result
    assert result["errors"] == []
    assert result["expected_review_type"] == case.expected_kind
    assert result["findings_by_status"].get("confirmed_change", 0) == 0


def test_all_matrix_cases_have_unique_truthful_ids_and_bounded_types():
    validate_cases(SCENARIOS)
    assert 20 <= len(SCENARIOS) <= MAX_CASES
    assert len({case.id for case in SCENARIOS}) == len(SCENARIOS)
    assert {case.layout for case in SCENARIOS} == {
        "rules", "rectangles", "fills", "borderless", "broken",
    }
    assert {case.rotation for case in SCENARIOS} == {0, 90, 180, 270}
    assert set(HEADERS) == {"date", "fee", "time", "date-and-time"}
    assert {case.expected_kind for case in SCENARIOS if case.expected_kind} == set(HEADERS)
    assert any(case.expected_kind is None for case in SCENARIOS)


def test_supported_rows_and_fallbacks_are_independently_balanced():
    counted = Counter(case.expected_kind or "fallback" for case in SCENARIOS)
    assert counted["fallback"] >= 10
    assert counted["date"] >= 5
    assert counted["fee"] >= 2
    assert counted["time"] >= 3
    assert counted["date-and-time"] >= 3


@pytest.mark.parametrize("case_id", [
    "date_rotation_90", "date_rotation_180", "date_rotation_270",
    "fee_rectangles", "combined_rectangles",
])
def test_table_geometry_survives_native_pdf_rendering(case_id):
    case = next(case for case in SCENARIOS if case.id == case_id)
    content = render_pdf(
        case.header, case.original_row, layout=case.layout, rotation=case.rotation,
    )
    assert content.startswith(b"%PDF-")
    with fitz.open(stream=content, filetype="pdf") as pdf:
        assert len(pdf) == 1
        page = pdf[0]
        assert page.rotation == case.rotation
        assert FICTIONAL_MARKER in page.get_text()
        assert page.rect.width > 0 and page.rect.height > 0
        assert len(page.get_cdrawings()) > 0


@pytest.mark.parametrize("layout", ["fills", "borderless"])
def test_unsupported_unstroked_grids_remain_unjoined(layout):
    case = scenario(
        f"unruled_{layout}", "date", "2026-12-13",
        "2026-12-19", "2026-12-20", layout=layout, should_join=False,
    )
    result = check_case(case)
    assert result["pass"]
    assert result["expected_review_type"] is None
    assert result["findings_by_status"].get("confirmed_change", 0) == 0


@pytest.mark.parametrize("mutator", [
    lambda case: replace(case, id=""),
    lambda case: replace(case, id="contains space"),
    lambda case: replace(case, id="non_ascii_ह"),
    lambda case: replace(case, layout="unsupported"),
    lambda case: replace(case, rotation=15),
    lambda case: replace(case, expected_kind="unsupported"),
    lambda case: replace(case, header=("Activity", "Earlier date")),
    lambda case: replace(case, original_row=("Application deadline",)),
    lambda case: replace(case, revised_row=("Application deadline",)),
])
def test_bad_synthetic_case_definitions_fail_closed(mutator):
    invalid = mutator(SCENARIOS[0])
    with pytest.raises(ValueError):
        validate_cases((invalid,))


def test_repeated_ids_and_oversized_catalogue_rejected():
    first = SCENARIOS[0]
    with pytest.raises(ValueError, match="unique"):
        validate_cases((first, replace(first)))
    with pytest.raises(ValueError, match="bounded"):
        validate_cases(())
    with pytest.raises(ValueError, match="bounded"):
        validate_cases(tuple(replace(first, id=f"large_{i}") for i in range(MAX_CASES + 1)))


def test_runner_never_hides_case_failures_as_success(monkeypatch):
    from native_table_matrix import check_case as real_checker

    def modified_check(case):
        if case.id == "date_iso":
            raise RuntimeError("synthetic parser failure")
        return real_checker(case)

    monkeypatch.setattr("native_table_matrix.check_case", modified_check)
    outcome = run_matrix((SCENARIOS[0], SCENARIOS[1]))
    assert [item["pass"] for item in outcome] == [False, True]
    assert outcome[0]["errors"] == ["synthetic_execution_failed"]
    assert "synthetic parser failure" not in json.dumps(outcome)


def test_fixture_result_surfaces_missing_join_as_a_failure():
    baseline = SCENARIOS[0]
    # The declared row type is intentionally false: a filled layout is not
    # native ruled geometry, even though the table header is textually correct.
    malformed = replace(baseline, id="mismatched_geometry", layout="fills")
    outcome = check_case(malformed)
    assert not outcome["pass"]
    assert "original_typed_quote_not_preserved" in outcome["errors"]
    assert "revised_typed_quote_not_preserved" in outcome["errors"]


def test_full_matrix_is_deterministic_and_makes_no_accuracy_claims():
    first = run_matrix()
    second = run_matrix()
    assert first == second
    assert len(first) == len(SCENARIOS)
    assert all(item["pass"] for item in first)
    assert all("authority" not in item["id"] for item in first)
    assert "Application deadline" not in json.dumps(first)


def test_cli_json_contract_and_explicit_warning(capsys):
    assert main(["--json", "--case", "date_iso", "--case", "fee_rs"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["kind"] == "synthetic_native_table_regression"
    assert payload["synthetic_cases"] == 2
    assert payload["passing_cases"] == 2
    assert payload["failing_cases"] == 0
    assert [item["id"] for item in payload["cases"]] == ["date_iso", "fee_rs"]
    assert "do not measure real-world accuracy" in payload["warning"]
    assert "Application deadline" not in json.dumps(payload)


def test_cli_human_readable_summary_does_not_print_source_quotes(capsys):
    assert main(["--case", "date_iso"]) == 0
    printed = capsys.readouterr().out
    assert "1/1 generated cases passed" in printed
    assert "not an official" not in printed.lower()
    assert "Application deadline" not in printed
    assert "real-world accuracy" in printed


def test_cli_rejects_unknown_case_before_running(capsys):
    with pytest.raises(SystemExit) as exc:
        main(["--case", "unknown-real-notice"])
    assert exc.value.code == 2
    assert "invalid choice" in capsys.readouterr().err


def test_cli_subprocess_runs_without_cloud_or_local_pdf_dependencies():
    root = Path(__file__).resolve().parents[2]
    command = [
        sys.executable, str(root / "backend/benchmarks/native_table_matrix.py"),
        "--json", "--case", "date_iso", "--case", "combined_iso",
    ]
    result = subprocess.run(
        command, cwd=root, capture_output=True, text=True, timeout=30, check=True,
    )
    payload = json.loads(result.stdout)
    assert payload["synthetic_cases"] == payload["passing_cases"] == 2
    assert not payload["cases"][0]["errors"]
    assert not result.stderr


def test_table_audit_never_promotes_unsupported_currency_values():
    case = scenario(
        "unsupported_currency", "fee", "USD 300", "USD 450", "USD 500",
        should_join=False,
    )
    result = check_case(case)
    assert result["pass"], result
    assert result["findings_by_status"].get("confirmed_change", 0) == 0


def test_empty_source_cell_does_not_form_a_typed_revision():
    base = SCENARIOS[0]
    case = replace(
        base,
        id="incomplete_cell",
        original_row=("Application deadline", "2026-12-13", ""),
        revised_row=("Application deadline", "2026-12-13", ""),
        expected_kind=None,
    )
    result = check_case(case)
    assert result["pass"], result


def test_identical_source_values_do_not_generate_a_change_claim():
    base = SCENARIOS[0]
    identical = replace(base, id="unchanged_row", revised_row=base.original_row)
    result = check_case(identical)
    assert result["pass"], result
    assert result["findings_by_status"] == {}
