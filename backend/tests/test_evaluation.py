"""Keep the synthetic evaluation fixtures from silently regressing."""

import sys
from pathlib import Path

BENCHMARK_DIR = Path(__file__).resolve().parents[1] / "benchmarks"
sys.path.insert(0, str(BENCHMARK_DIR))
from evaluate import evaluate  # noqa: E402


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
