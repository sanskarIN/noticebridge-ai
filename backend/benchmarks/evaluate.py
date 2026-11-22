"""Run a transparent, synthetic (not production) comparison regression benchmark."""

import json
import sys
from collections import Counter
from pathlib import Path

import fitz

from noticebridge.compare import compare_documents
from noticebridge.extract import extract_pdf


def build_pdf(lines: list[str]) -> bytes:
    document = fitz.open()
    page = document.new_page(width=800, height=850)
    for number, line in enumerate(lines):
        page.insert_text((50, 65 + number * 30), line, fontsize=13)
    contents = document.tobytes()
    document.close()
    return contents


def evaluate() -> list[dict]:
    fixtures = json.loads(Path(__file__).with_name("cases.json").read_text())
    results: list[dict] = []
    for sample in fixtures:
        old = extract_pdf(build_pdf(sample["original"]), document_id="original", filename="a.pdf")
        new = extract_pdf(build_pdf(sample["revised"]), document_id="revised", filename="b.pdf")
        report = compare_documents(old, new)
        actual_counts = dict(Counter(f.status for f in report.findings))
        actual_values = sorted(
            d.outcome for f in report.findings for d in f.field_changes
        )
        expected_values = sorted(sample.get("expected_field_outcomes", []))
        # No finding may ever be labeled source-authority-verified in this prototype.
        no_false_authority = all(not f.authority_verified for f in report.findings)
        evidence_backed = all(
            f.original is not None or f.revised is not None or f.supporting_evidence
            for f in report.findings
        )
        results.append({
            "id": sample["id"],
            "pass": actual_counts == sample["expected_status_counts"]
            and actual_values == expected_values
            and no_false_authority and evidence_backed,
            "expected_status_counts": sample["expected_status_counts"],
            "actual_status_counts": actual_counts,
            "expected_field_outcomes": expected_values,
            "actual_field_outcomes": actual_values,
            "no_false_authority": no_false_authority,
            "evidence_backed": bool(evidence_backed),
        })
    return results


if __name__ == "__main__":
    result = evaluate()
    print(json.dumps({
        "synthetic_cases": len(result),
        "passing_cases": sum(item["pass"] for item in result),
        "case_results": result,
        "warning": "Synthetic regression fixtures do not measure real-world accuracy.",
    }, indent=2))
    if not all(item["pass"] for item in result):
        sys.exit(1)
