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


def render_rows_pdf(
    rows: tuple[tuple[str, str, str], ...],
    *,
    layout: Layout,
    rotation: int,
) -> bytes:
    """Create a bounded native-text grid, including consecutive typed sections."""
    if not 2 <= len(rows) <= 10:
        raise ValueError("Synthetic PDF table row count is out of bounds")
    columns = (40, 290, 610, 970)
    boundaries = [65 + index * 46 for index in range(len(rows) + 1)]
    with fitz.open() as document:
        page = document.new_page(width=1000, height=650)
        page.insert_text((45, 25), FICTIONAL_MARKER, fontsize=10)
        if layout in ("rules", "broken"):
            for y in boundaries:
                page.draw_line((columns[0], y), (columns[-1], y))
            for index, x in enumerate(columns):
                start = boundaries[1] + 5 if layout == "broken" and index == 1 else boundaries[0]
                page.draw_line((x, start), (x, boundaries[-1]))
        elif layout in ("rectangles", "fills"):
            for y0, y1 in zip(boundaries, boundaries[1:], strict=False):
                for x0, x1 in zip(columns, columns[1:], strict=False):
                    rect = fitz.Rect(x0, y0, x1, y1)
                    if layout == "fills":
                        page.draw_rect(rect, color=None, fill=(0.92, 0.94, 0.96))
                    else:
                        page.draw_rect(rect, color=(0, 0, 0))
        for index, row in enumerate(rows):
            for x, value in zip(columns, row, strict=False):
                if value:
                    page.insert_text((x + 10, boundaries[index] + 25), value, fontsize=10.5)
        page.set_rotation(rotation)
        return document.tobytes()


def render_pdf(
    header: tuple[str, str, str],
    row: tuple[str, str, str],
    *,
    layout: Layout,
    rotation: int,
) -> bytes:
    """Render one typed header and one source row using the shared grid layout."""
    return render_rows_pdf((header, row), layout=layout, rotation=rotation)

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



@dataclass(frozen=True)
class SequenceScenario:
    """Explicit native rows; the first row is a header in each source PDF."""

    id: str
    original_rows: tuple[tuple[str, str, str], ...]
    revised_rows: tuple[tuple[str, str, str], ...]
    joined_indices: tuple[int, ...]
    warning_kinds: tuple[TableKind, ...]
    layout: Layout = "rules"
    rotation: Literal[0, 90, 180, 270] = 0


SEQUENCES: tuple[SequenceScenario, ...] = (
    SequenceScenario(
        "two_consecutive_deadlines",
        (HEADERS["date"],
         ("Application deadline", "2026-12-13", "2026-12-19"),
         ("Registration deadline", "2026-12-14", "2026-12-20")),
        (HEADERS["date"],
         ("Application deadline", "2026-12-13", "2026-12-21"),
         ("Registration deadline", "2026-12-14", "2026-12-22")),
        (1, 2), ("date",),
    ),
    SequenceScenario(
        "two_consecutive_fees",
        (HEADERS["fee"],
         ("Application fee", "Rs. 300", "Rs. 450"),
         ("Examination fee", "Rs. 400", "Rs. 550")),
        (HEADERS["fee"],
         ("Application fee", "Rs. 300", "Rs. 500"),
         ("Examination fee", "Rs. 400", "Rs. 600")),
        (1, 2), ("fee",),
    ),
    SequenceScenario(
        "two_consecutive_times",
        (HEADERS["time"],
         ("Reporting time", "17:00 IST", "18:00 IST"),
         ("Exam time", "09:00 IST", "10:00 IST")),
        (HEADERS["time"],
         ("Reporting time", "17:00 IST", "19:00 IST"),
         ("Exam time", "09:00 IST", "11:00 IST")),
        (1, 2), ("time",),
    ),
    SequenceScenario(
        "combined_cutoff_rows",
        (HEADERS["date-and-time"],
         ("Application deadline", "2026-12-13 at 17:00 IST",
          "2026-12-19 at 18:00 IST"),
         ("Registration deadline", "2026-12-14 at 17:00 IST",
          "2026-12-20 at 18:00 IST")),
        (HEADERS["date-and-time"],
         ("Application deadline", "2026-12-13 at 17:00 IST",
          "2026-12-21 at 19:00 IST"),
         ("Registration deadline", "2026-12-14 at 17:00 IST",
          "2026-12-22 at 19:00 IST")),
        (1, 2), ("date-and-time",),
    ),
    SequenceScenario(
        "fee_then_time_header_switch",
        (HEADERS["fee"], ("Application fee", "Rs. 300", "Rs. 450"),
         HEADERS["time"], ("Reporting time", "17:00 IST", "18:00 IST")),
        (HEADERS["fee"], ("Application fee", "Rs. 300", "Rs. 500"),
         HEADERS["time"], ("Reporting time", "17:00 IST", "19:00 IST")),
        (1, 3), ("fee", "time"),
    ),
    SequenceScenario(
        "date_then_fee_header_switch",
        (HEADERS["date"],
         ("Application deadline", "2026-12-13", "2026-12-19"),
         HEADERS["fee"], ("Application fee", "Rs. 300", "Rs. 450")),
        (HEADERS["date"],
         ("Application deadline", "2026-12-13", "2026-12-21"),
         HEADERS["fee"], ("Application fee", "Rs. 300", "Rs. 500")),
        (1, 3), ("date", "fee"),
    ),
    SequenceScenario(
        "invalid_value_breaks_header_inheritance",
        (HEADERS["date"],
         ("Application deadline", "2026-12-13", "2026-12-19"),
         ("Registration deadline", "2026-12-14", "13th to 15th December 2026"),
         ("Interview deadline", "2026-12-15", "2026-12-20")),
        (HEADERS["date"],
         ("Application deadline", "2026-12-13", "2026-12-21"),
         ("Registration deadline", "2026-12-14", "13th to 16th December 2026"),
         ("Interview deadline", "2026-12-15", "2026-12-22")),
        (1,), ("date",),
    ),
    SequenceScenario(
        "repeated_header_restores_inheritance",
        (HEADERS["date"],
         ("Application deadline", "2026-12-13", "2026-12-19"),
         ("Registration deadline", "2026-12-14", "13th to 15th December 2026"),
         HEADERS["date"],
         ("Interview deadline", "2026-12-15", "2026-12-20")),
        (HEADERS["date"],
         ("Application deadline", "2026-12-13", "2026-12-21"),
         ("Registration deadline", "2026-12-14", "13th to 16th December 2026"),
         HEADERS["date"],
         ("Interview deadline", "2026-12-15", "2026-12-22")),
        (1, 4), ("date",),
    ),
    SequenceScenario(
        "unrelated_row_breaks_header_inheritance",
        (HEADERS["date"],
         ("Application deadline", "2026-12-13", "2026-12-19"),
         ("Venue", "2026-12-14", "2026-12-20"),
         ("Registration deadline", "2026-12-15", "2026-12-21")),
        (HEADERS["date"],
         ("Application deadline", "2026-12-13", "2026-12-22"),
         ("Venue", "2026-12-14", "2026-12-23"),
         ("Registration deadline", "2026-12-15", "2026-12-24")),
        (1,), ("date",),
    ),
    SequenceScenario(
        "unruled_rows_remain_independent",
        (HEADERS["date"],
         ("Application deadline", "2026-12-13", "2026-12-19"),
         ("Registration deadline", "2026-12-14", "2026-12-20")),
        (HEADERS["date"],
         ("Application deadline", "2026-12-13", "2026-12-21"),
         ("Registration deadline", "2026-12-14", "2026-12-22")),
        (), (), "borderless",
    ),
    SequenceScenario(
        "rotated_multirow_rectangles",
        (HEADERS["fee"],
         ("Application fee", "INR 300", "INR 450"),
         ("Examination fee", "INR 400", "INR 550")),
        (HEADERS["fee"],
         ("Application fee", "INR 300", "INR 500"),
         ("Examination fee", "INR 400", "INR 600")),
        (1, 2), ("fee",), "rectangles", 270,
    ),
)


def validate_sequences(cases: tuple[SequenceScenario, ...]) -> None:
    if not 1 <= len(cases) <= MAX_CASES:
        raise ValueError("Multirow table matrix must be nonempty and bounded")
    identifiers = [case.id for case in cases]
    if len(identifiers) != len(set(identifiers)):
        raise ValueError("Multirow scenario IDs must be unique")
    for case in cases:
        if not case.id or not all(c.isascii() and (c.isalnum() or c == "_") for c in case.id):
            raise ValueError("Invalid multirow scenario identifier")
        if not 2 <= len(case.original_rows) == len(case.revised_rows) <= 10:
            raise ValueError("Invalid multirow PDF table row count")
        if any(len(row) != 3 for row in (*case.original_rows, *case.revised_rows)):
            raise ValueError("Multirow scenario has an invalid column count")
        if case.joined_indices != tuple(sorted(set(case.joined_indices))):
            raise ValueError("Multirow joined indices must be unique and ordered")
        if any(index < 1 or index >= len(case.original_rows) for index in case.joined_indices):
            raise ValueError("Multirow joined index points outside source rows")
        if len(set(case.warning_kinds)) != len(case.warning_kinds):
            raise ValueError("Multirow warning kinds must be unique")
        if any(kind not in HEADERS for kind in case.warning_kinds):
            raise ValueError("Multirow warning category is unsupported")
        if case.layout not in ("rules", "rectangles", "fills", "borderless", "broken"):
            raise ValueError("Multirow table layout is unsupported")
        if case.rotation not in (0, 90, 180, 270):
            raise ValueError("Multirow page rotation is unsupported")


def _sequence_source_errors(
    case: SequenceScenario, document, rows: tuple[tuple[str, str, str], ...],
    role: str,
) -> list[str]:
    errors: list[str] = []
    actual = [line.text for line in document.lines]
    for index, row in enumerate(rows):
        if index in case.joined_indices:
            quoted = " ".join(row)
            if sum(line.text == quoted and line.review_only for line in document.lines) != 1:
                errors.append(f"{role}_missing_joined_row_{index}")
        elif not all(cell in actual for cell in row if cell):
            errors.append(f"{role}_lost_independent_row_{index}")
    expected_warnings = [
        f"{role}: page 1 contains an earlier/revised {kind} table; "
        "both printed values are retained, verify the column headings"
        for kind in case.warning_kinds
    ]
    actual_warnings = [
        warning for warning in document.warnings if "earlier/revised" in warning
    ]
    if sorted(expected_warnings) != sorted(actual_warnings):
        errors.append(f"{role}_unexpected_table_warning_set")
    if FICTIONAL_MARKER not in actual:
        errors.append(f"{role}_missing_fictional_marker")
    for line in document.lines:
        evidence = line.evidence
        if (evidence.document_id != role or evidence.page != 1
                or evidence.page_rotation != case.rotation
                or evidence.extraction_method != "native"):
            errors.append(f"{role}_invalid_source_metadata")
            break
        x0, y0, x1, y1 = evidence.bbox
        if not all(map(math.isfinite, evidence.bbox)) or not (x0 < x1 and y0 < y1):
            errors.append(f"{role}_invalid_source_bbox")
            break
    return errors


def check_sequence(case: SequenceScenario) -> dict:
    old_bytes = render_rows_pdf(case.original_rows, layout=case.layout, rotation=case.rotation)
    new_bytes = render_rows_pdf(case.revised_rows, layout=case.layout, rotation=case.rotation)
    old = extract_pdf(old_bytes, document_id="original", filename="original.pdf")
    new = extract_pdf(new_bytes, document_id="revised", filename="revised.pdf")
    report = compare_documents(old, new)
    errors = [
        *_sequence_source_errors(case, old, case.original_rows, "original"),
        *_sequence_source_errors(case, new, case.revised_rows, "revised"),
    ]
    if any(f.status == "confirmed_change" for f in report.findings):
        errors.append("unverified_sequence_confirmed")
    if any(value.outcome == "changed" for f in report.findings for value in f.field_changes):
        errors.append("unverified_sequence_field_change")
    if any(f.authority_verified for f in report.findings):
        errors.append("unverified_sequence_authority")
    try:
        verify_report_provenance(
            report,
            original=old_bytes,
            revised=new_bytes,
            old_name="original.pdf",
            new_name="revised.pdf",
        )
    except ValueError:
        errors.append("parent_rejected_sequence_report")
    return {
        "id": case.id,
        "pass": not errors,
        "layout": case.layout,
        "rotation": case.rotation,
        "expected_review_type": "multirow",
        "findings_by_status": dict(sorted(Counter(f.status for f in report.findings).items())),
        "errors": errors,
    }


def run_sequence_matrix(cases: tuple[SequenceScenario, ...] = SEQUENCES) -> list[dict]:
    validate_sequences(cases)
    records: list[dict] = []
    for case in cases:
        try:
            records.append(check_sequence(case))
        except (RuntimeError, ValueError, OSError, AssertionError):
            records.append({
                "id": case.id,
                "pass": False,
                "layout": case.layout,
                "rotation": case.rotation,
                "expected_review_type": "multirow",
                "findings_by_status": {},
                "errors": ["synthetic_sequence_execution_failed"],
            })
    return records


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="Emit machine-readable results")
    parser.add_argument("--case", action="append", choices=[item.id for item in SCENARIOS])
    parser.add_argument("--sequence", action="append", choices=[item.id for item in SEQUENCES])
    options = parser.parse_args(argv)
    filtered = bool(options.case or options.sequence)
    selected = (
        tuple(case for case in SCENARIOS if case.id in (options.case or ()))
        if filtered else SCENARIOS
    )
    selected_sequences = (
        tuple(case for case in SEQUENCES if case.id in (options.sequence or ()))
        if filtered else SEQUENCES
    )
    outcome = (
        (run_matrix(selected) if selected else [])
        + (run_sequence_matrix(selected_sequences) if selected_sequences else [])
    )
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
