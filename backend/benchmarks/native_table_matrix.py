"""Generated-PDF conformance matrix for native evidence-table safety.

This is a deterministic regression check, NOT a real-world accuracy estimate.
All passages are fictional and generated in memory; the runner neither reads
untrusted data files nor contacts an official site, AI endpoint or browser.
"""

import argparse
import json
import math
import sys
from collections import Counter
from dataclasses import dataclass
from typing import Literal

import pymupdf as fitz

from noticebridge.compare import compare_documents
from noticebridge.extract import extract_pdf
from noticebridge.provenance import verify_report_provenance

TableKind = Literal["date", "fee", "time", "date-and-time"]
Layout = Literal["rules", "rectangles", "fills", "borderless", "broken"]

HEADERS: dict[TableKind, tuple[str, str, str]] = {
    "date": ("Activity", "Earlier date", "Revised date"),
    "fee": ("Activity", "Earlier fee", "Revised fee"),
    "time": ("Activity", "Earlier time", "Revised time"),
    "date-and-time": ("Activity", "Earlier date/time", "Revised date/time"),
}
LABELS = {
    "date": "Application deadline",
    "fee": "Application fee",
    "time": "Reporting time",
    "date-and-time": "Application deadline",
}
FICTIONAL_MARKER = "FICTIONAL TEST DATA - NOT AN OFFICIAL NOTICE"
MAX_CASES = 60


@dataclass(frozen=True)
class Scenario:
    id: str
    header: tuple[str, str, str]
    original_row: tuple[str, str, str]
    revised_row: tuple[str, str, str]
    expected_kind: TableKind | None
    layout: Layout = "rules"
    rotation: Literal[0, 90, 180, 270] = 0


def scenario(
    id: str,
    kind: TableKind,
    earlier: str,
    revised_before: str,
    revised_after: str,
    *,
    expected_kind: TableKind | None = None,
    should_join: bool = True,
    layout: Layout = "rules",
    rotation: Literal[0, 90, 180, 270] = 0,
    header: tuple[str, str, str] | None = None,
    label: str | None = None,
) -> Scenario:
    subject = label or LABELS[kind]
    return Scenario(
        id=id,
        header=header or HEADERS[kind],
        original_row=(subject, earlier, revised_before),
        revised_row=(subject, earlier, revised_after),
        expected_kind=(expected_kind or kind) if should_join else None,
        layout=layout,
        rotation=rotation,
    )


SCENARIOS: tuple[Scenario, ...] = (
    scenario("date_iso", "date", "2026-12-13", "2026-12-19", "2026-12-20"),
    scenario("date_named", "date", "13 December 2026", "19 December 2026",
             "20 December 2026"),
    scenario("date_rectangles", "date", "2026-12-13", "2026-12-19", "2026-12-20",
             layout="rectangles"),
    scenario("date_rotation_90", "date", "2026-12-13", "2026-12-19", "2026-12-20",
             rotation=90),
    scenario("date_rotation_180", "date", "2026-12-13", "2026-12-19", "2026-12-20",
             rotation=180),
    scenario("date_rotation_270", "date", "2026-12-13", "2026-12-19", "2026-12-20",
             rotation=270),
    scenario("fee_rs", "fee", "Rs. 300", "Rs. 450", "Rs. 500"),
    scenario("fee_inr", "fee", "INR 300", "INR 450", "INR 500"),
    scenario("fee_rectangles", "fee", "INR 300", "INR 450", "INR 500",
             layout="rectangles"),
    scenario("time_ist", "time", "17:00 IST", "18:00 IST", "19:00 IST"),
    scenario("time_clock_only", "time", "17:00", "18:00", "19:00"),
    scenario("time_utc_offsets", "time", "17:00 UTC+05:30",
             "18:00 UTC+06:00", "19:00 UTC+06:00"),
    scenario("time_rectangles", "time", "17:00 IST", "18:00 IST", "19:00 IST",
             layout="rectangles"),
    scenario("combined_iso", "date-and-time", "2026-12-13 at 17:00 IST",
             "2026-12-19 at 18:00 IST", "2026-12-20 at 19:00 IST"),
    scenario("combined_different_zones", "date-and-time",
             "2026-12-13 at 17:00 UTC+05:30",
             "2026-12-19 at 18:00 UTC+06:00",
             "2026-12-20 at 19:00 UTC+06:00"),
    scenario("combined_rectangles", "date-and-time", "2026-12-13 at 17:00 IST",
             "2026-12-19 at 18:00 IST", "2026-12-20 at 19:00 IST",
             layout="rectangles"),
    scenario("date_fill_only", "date", "2026-12-13", "2026-12-19", "2026-12-20",
             layout="fills", should_join=False),
    scenario("fee_borderless", "fee", "INR 300", "INR 450", "INR 500",
             layout="borderless", should_join=False),
    scenario("time_broken_divider", "time", "17:00 IST", "18:00 IST",
             "19:00 IST", layout="broken", should_join=False),
    scenario("combined_fill_only", "date-and-time", "2026-12-13 at 17:00 IST",
             "2026-12-19 at 18:00 IST", "2026-12-20 at 19:00 IST",
             layout="fills", should_join=False),
    scenario("date_generic_headings", "date", "2026-12-13", "2026-12-19",
             "2026-12-20", header=("Activity", "Date", "Date"), should_join=False),
    scenario("date_reversed_headings", "date", "2026-12-13", "2026-12-19",
             "2026-12-20", header=("Activity", "Revised date", "Earlier date"),
             should_join=False),
    scenario("fee_generic_headings", "fee", "INR 300", "INR 450", "INR 500",
             header=("Activity", "Old", "New"), should_join=False),
    scenario("time_incorrect_headings", "time", "17:00 IST", "18:00 IST",
             "19:00 IST", header=("Activity", "Earlier fee", "Revised fee"),
             should_join=False),
    scenario("invalid_calendar_date", "date", "2026-13-13",
             "2026-12-19", "2026-12-20", should_join=False),
    scenario("ambiguous_numeric_date", "date", "03/04/2026",
             "05/06/2026", "07/08/2026", should_join=False),
    scenario("compact_date_range", "date", "13 December 2026",
             "13th to 15th December 2026", "13th to 16th December 2026",
             should_join=False),
    scenario("ambiguous_clock_range", "time", "17:00 IST",
             "18:00 to 19:00 IST", "19:00 to 20:00 IST", should_join=False),
    scenario("invalid_clock", "time", "17:00 IST", "18:75 IST",
             "19:80 IST", should_join=False),
    scenario("unsupported_fee_currency", "fee", "USD 300", "USD 450",
             "USD 500", should_join=False),
    scenario("fee_without_currency", "fee", "300", "450", "500",
             should_join=False),
    scenario("combined_two_clocks", "date-and-time", "2026-12-13 at 17:00 IST",
             "2026-12-19 at 18:00 to 19:00 IST",
             "2026-12-20 at 19:00 to 20:00 IST", should_join=False),
    scenario("combined_date_only", "date-and-time", "2026-12-13",
             "2026-12-19", "2026-12-20", should_join=False),
    scenario("label_not_a_deadline", "date", "2026-12-13", "2026-12-19",
             "2026-12-20", label="Street parking", should_join=False),
)


def validate_cases(cases: tuple[Scenario, ...]) -> None:
    if not 1 <= len(cases) <= MAX_CASES:
        raise ValueError("Synthetic table matrix must be nonempty and bounded")
    ids = [case.id for case in cases]
    if len(ids) != len(set(ids)) or any(not item.isascii() for item in ids):
        raise ValueError("Synthetic table case IDs must be unique ASCII text")
    for case in cases:
        if not case.id or not all(char.isalnum() or char == "_" for char in case.id):
            raise ValueError("Invalid synthetic case identifier")
        if case.layout not in ("rules", "rectangles", "fills", "borderless", "broken"):
            raise ValueError("Unsupported PDF table layout")
        if case.rotation not in (0, 90, 180, 270):
            raise ValueError("Unsupported PDF page rotation")
        if len(case.header) != 3 or len(case.original_row) != 3 or len(case.revised_row) != 3:
            raise ValueError("Expected exactly three table columns")
        if case.expected_kind is not None and case.expected_kind not in HEADERS:
            raise ValueError("Unsupported expected typed table")


def render_pdf(header: tuple[str, str, str], row: tuple[str, str, str],
               *, layout: Layout, rotation: int) -> bytes:
    """Construct a self-contained, non-scanned fictional grid without external assets."""
    columns = (40, 290, 610, 970)
    top, middle, bottom = 65, 111, 157
    with fitz.open() as document:
        page = document.new_page(width=1000, height=500)
        page.insert_text((45, 25), FICTIONAL_MARKER, fontsize=10)
        if layout in ("rules", "broken"):
            for y in (top, middle, bottom):
                page.draw_line((columns[0], y), (columns[-1], y))
            for index, x in enumerate(columns):
                y = middle + 5 if layout == "broken" and index == 1 else top
                page.draw_line((x, y), (x, bottom))
        elif layout in ("rectangles", "fills"):
            for y0, y1 in ((top, middle), (middle, bottom)):
                for x0, x1 in zip(columns, columns[1:], strict=False):
                    rect = fitz.Rect(x0, y0, x1, y1)
                    if layout == "fills":
                        page.draw_rect(rect, color=None, fill=(0.92, 0.94, 0.96))
                    else:
                        page.draw_rect(rect, color=(0, 0, 0))
        for y, cells in ((90, header), (136, row)):
            for x, value in zip(columns, cells, strict=False):
                if value:
                    page.insert_text((x + 10, y), value, fontsize=10.5)
        page.set_rotation(rotation)
        return document.tobytes()


def _source_errors(case: Scenario, document, row: tuple[str, str, str],
                   role: str) -> list[str]:
    errors: list[str] = []
    texts = [line.text for line in document.lines]
    merged = " ".join(row)
    grouped = [line for line in document.lines if line.text == merged and line.review_only]
    table_warning = (
        f"{role}: page 1 contains an earlier/revised {case.expected_kind} table; "
        "both printed values are retained, verify the column headings"
    )
    if case.expected_kind is not None:
        if len(grouped) != 1:
            errors.append(f"{role}_typed_quote_not_preserved")
        if document.warnings.count(table_warning) != 1:
            errors.append(f"{role}_missing_unique_table_warning")
    else:
        if any(line.review_only for line in document.lines):
            errors.append(f"{role}_unsupported_cell_was_joined")
        if not all(text in texts for text in row if text):
            errors.append(f"{role}_fallback_lost_source_cell")
        if any("earlier/revised" in warning for warning in document.warnings):
            errors.append(f"{role}_unsupported_table_warning")
    if FICTIONAL_MARKER not in texts:
        errors.append(f"{role}_synthetic_origin_not_labeled")
    for evidence in (line.evidence for line in document.lines):
        if evidence.document_id != role or evidence.page != 1:
            errors.append(f"{role}_wrong_page_or_role")
            break
        if evidence.page_rotation != case.rotation:
            errors.append(f"{role}_incorrect_page_rotation")
            break
        if evidence.extraction_method != "native":
            errors.append(f"{role}_unexpected_machine_ocr")
            break
        x0, y0, x1, y1 = evidence.bbox
        if not all(map(math.isfinite, evidence.bbox)) or not (x0 < x1 and y0 < y1):
            errors.append(f"{role}_invalid_bounding_box")
            break
    return errors


def check_case(case: Scenario) -> dict:
    """Score invariants, never claim a synthetic result measures issuer accuracy."""
    original_bytes = render_pdf(
        case.header, case.original_row, layout=case.layout, rotation=case.rotation,
    )
    revised_bytes = render_pdf(
        case.header, case.revised_row, layout=case.layout, rotation=case.rotation,
    )
    original = extract_pdf(original_bytes, document_id="original", filename="original.pdf")
    revised = extract_pdf(revised_bytes, document_id="revised", filename="revised.pdf")
    report = compare_documents(original, revised)
    errors = [
        *_source_errors(case, original, case.original_row, "original"),
        *_source_errors(case, revised, case.revised_row, "revised"),
    ]
    if any(f.status == "confirmed_change" for f in report.findings):
        errors.append("unverified_revision_marked_confirmed")
    if any(value.outcome == "changed" for f in report.findings for value in f.field_changes):
        errors.append("unverified_revision_claimed_changed_field")
    if any(f.authority_verified for f in report.findings):
        errors.append("unverified_revision_claimed_issuer_authority")
    if not all(
        f.original is not None or f.revised is not None or f.supporting_evidence
        for f in report.findings
    ):
        errors.append("unbacked_finding")
    try:
        verify_report_provenance(
            report,
            original=original_bytes,
            revised=revised_bytes,
            old_name="original.pdf",
            new_name="revised.pdf",
        )
    except ValueError:
        errors.append("parent_rejected_synthetic_report")
    return {
        "id": case.id,
        "pass": not errors,
        "layout": case.layout,
        "rotation": case.rotation,
        "expected_review_type": case.expected_kind,
        "findings_by_status": dict(sorted(Counter(f.status for f in report.findings).items())),
        "errors": errors,
    }


def run_matrix(cases: tuple[Scenario, ...] = SCENARIOS) -> list[dict]:
    """Keep per-case failures visible instead of swallowing an entire regression."""
    validate_cases(cases)
    results = []
    for case in cases:
        try:
            results.append(check_case(case))
        except (RuntimeError, ValueError, OSError, AssertionError):
            # Only fixed generated data is ever processed here. This error code
            # deliberately does not echo text passages or Python tracebacks.
            results.append({
                "id": case.id,
                "pass": False,
                "layout": case.layout,
                "rotation": case.rotation,
                "expected_review_type": case.expected_kind,
                "findings_by_status": {},
                "errors": ["synthetic_execution_failed"],
            })
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="Emit machine-readable results")
    parser.add_argument("--case", action="append", choices=[item.id for item in SCENARIOS])
    options = parser.parse_args(argv)
    selected = (
        tuple(case for case in SCENARIOS if case.id in options.case)
        if options.case else SCENARIOS
    )
    outcome = run_matrix(selected)
    passed = sum(item["pass"] for item in outcome)
    payload = {
        "kind": "synthetic_native_table_regression",
        "synthetic_cases": len(outcome),
        "passing_cases": passed,
        "failing_cases": len(outcome) - passed,
        "cases": outcome,
        "warning": "These generated PDFs do not measure real-world accuracy or official authority.",
    }
    if options.json:
        print(json.dumps(payload, indent=2))
    else:
        print(f"Native table regression: {passed}/{len(outcome)} generated cases passed")
        for item in outcome:
            if not item["pass"]:
                print(f"FAIL {item['id']}: {', '.join(item['errors'])}")
        print(payload["warning"])
    return 0 if passed == len(outcome) else 1


if __name__ == "__main__":
    sys.exit(main())
