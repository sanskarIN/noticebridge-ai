"""Keep the synthetic evaluation fixtures from silently regressing."""

import json
import os
import subprocess
import sys
from pathlib import Path

BENCHMARK_DIR = Path(__file__).resolve().parents[1] / "benchmarks"
sys.path.insert(0, str(BENCHMARK_DIR))
from evaluate import evaluate  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))


def test_fictional_notice_evaluation_matrix():
    results = evaluate()
    failures = [result for result in results if not result["pass"]]
    assert not failures, failures
    assert len(results) >= 12


def test_fictional_demo_pdf_pair_is_truthfully_evidence_linked(tmp_path):
    from generate_demo import generate_pair

    from noticebridge.compare import compare_documents
    from noticebridge.extract import extract_pdf

    a, b = generate_pair(tmp_path)
    old = extract_pdf(a.read_bytes(), document_id="original", filename=a.name)
    new = extract_pdf(b.read_bytes(), document_id="revised", filename=b.name)
    report = compare_documents(old, new)
    actual = [finding for finding in report.findings if finding.status == "confirmed_change"]
    assert len(actual) == len(report.findings) == 2
    assert {finding.category for finding in actual} == {"deadline", "fee"}
    assert all(finding.original and finding.revised for finding in actual)
    assert all(not finding.authority_verified for finding in report.findings)
    assert any("FICTIONAL NOTICE" in line.text for line in old.lines)


def test_fictional_benchmark_cli_emits_clean_json():
    """Warnings on stdout would corrupt automated benchmark ingestion."""
    root = Path(__file__).resolve().parents[2]
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(root / "backend")
    run = subprocess.run(
        [sys.executable, str(root / "backend/benchmarks/evaluate.py")],
        cwd=root, env=environment, text=True,
        capture_output=True, check=True, timeout=30,
    )
    payload = json.loads(run.stdout)
    assert payload["synthetic_cases"] >= 12
    assert payload["passing_cases"] == payload["synthetic_cases"]
    assert "Synthetic regression" in payload["warning"]



def test_python_ci_constraint_manifest_has_strict_unique_versions():
    """Future CI updates must not accidentally restore drifting package specs."""
    from verify_python_constraints import expected_versions

    versions = expected_versions()
    assert len(versions) >= 20
    assert versions["pymupdf"].count(".") == 2
    assert versions["fastapi"].count(".") == 2


def test_python_ci_constraint_parser_rejects_unpinned_or_duplicate_specs(tmp_path):
    import pytest

    from verify_python_constraints import expected_versions

    original = (Path(__file__).resolve().parents[1] / "constraints-py312.txt").read_text()
    for mutated in (
        original + "\nfastapi>=0.115\n",
        original + "\nfastapi==0.165.0\n",
        original.replace("ruff==0.17.6", "ruff @ https://example.invalid/package.whl"),
    ):
        file = tmp_path / "constraints.txt"
        file.write_text(mutated, encoding="utf-8")
        with pytest.raises(ValueError):
            expected_versions(file)
