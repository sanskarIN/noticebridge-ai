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
