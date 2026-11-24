"""Generated PDFs exercise ruled table evidence through extraction and the live worker."""

import hashlib

import pymupdf as fitz
import pytest
from fastapi.testclient import TestClient

from noticebridge.api import app
from noticebridge.extract import extract_pdf

HEADER = ("Requirement", "Published value")
DEADLINE = ("Application deadline", "13 December 2026")
FEE = ("Application fee", "Rs. 300")


def _notice(rows, *, layout="rules", rotation=0):
    with fitz.open() as document:
        page = document.new_page(width=610, height=500)
        table_top = 60
        row_height = 38
        boundaries = [table_top + index * row_height for index in range(len(rows) + 1)]
        columns = (50, 265, 430, 550) if layout == "three_columns" else (50, 265, 460)
        if layout in ("rules", "three_columns", "partial_divider"):
            for y in boundaries:
                page.draw_line((columns[0], y), (columns[-1], y))
            for x in columns:
                top = boundaries[1] + 5 if layout == "partial_divider" and x == 265 else table_top
                page.draw_line((x, top), (x, boundaries[-1]))
        if layout in ("rectangles", "fills"):
            for top, bottom in zip(boundaries[:-1], boundaries[1:], strict=True):
                for left, right in zip(columns[:-1], columns[1:], strict=True):
                    box = (left, top, right, bottom)
                    if layout == "fills":
                        page.draw_rect(box, color=None, fill=(0.9, 0.9, 0.9))
                    else:
                        page.draw_rect(box)
        for index, row in enumerate(rows):
            baseline = boundaries[index] + 17
            for x, text in zip(columns, row, strict=False):
                if text:
                    page.insert_text((x + 10, baseline), text, fontsize=11)
        page.set_rotation(rotation)
        return document.tobytes()


@pytest.mark.parametrize(("layout", "rotation"), [("rules", 0), ("rectangles", 90)])
def test_native_table_quotes_preserve_both_cells_and_source_geometry(layout, rotation):
    pdf = _notice([HEADER, DEADLINE, FEE], layout=layout, rotation=rotation)
    document = extract_pdf(pdf, document_id="original", filename="table.pdf")
    assert document.summary.sha256 == hashlib.sha256(pdf).hexdigest()
    assert [line.text for line in document.lines] == [
        "Requirement", "Published value", "Application deadline 13 December 2026",
        "Application fee Rs. 300",
    ]
    evidence = document.lines[2].evidence
    assert (evidence.page, evidence.page_rotation, evidence.extraction_method) == (
        1, rotation, "native",
    )
    x0, y0, x1, y1 = evidence.bbox
    assert 50 < x0 < 265 < x1 < 460
    assert 98 < y0 < y1 < 136


@pytest.mark.parametrize(("layout", "rows"), [
    ("borderless", [HEADER, DEADLINE]),
    ("fills", [HEADER, DEADLINE]),
    ("three_columns", [("Requirement", "Original", "Updated"), (*DEADLINE, "14 December 2026")]),
    ("partial_divider", [HEADER, DEADLINE]),
    ("rules", [DEADLINE]),
    ("rules", [HEADER, (DEADLINE[0], ""), ("", DEADLINE[1])]),
    ("rules", [HEADER, ("", DEADLINE[1])]),
    ("rules", [HEADER, ("Application deadline 12 December 2026", DEADLINE[1])]),
])
def test_ambiguous_layout_keeps_original_passages(layout, rows):
    document = extract_pdf(
        _notice(rows, layout=layout), document_id="original", filename="original.pdf",
    )
    assert [line.text for line in document.lines] == [
        value for row in rows for value in row if value
    ]


def test_wrapped_label_preserves_every_line():
    pdf = _notice([HEADER, DEADLINE], layout="rectangles")
    with fitz.open(stream=pdf) as source:
        source[0].insert_text((60, 130), "Phase 2 only", fontsize=8)
        pdf = source.tobytes()
    doc = extract_pdf(pdf, document_id="original", filename="original.pdf")
    assert [line.text for line in doc.lines][-3:] == [*DEADLINE, "Phase 2 only"]


def test_selected_ocr_keeps_cell_text_separate(monkeypatch):
    def transcribe(page):
        return page.get_text("dict", flags=0, sort=True)

    monkeypatch.setattr("noticebridge.extract._extract_ocr_dict", transcribe)
    doc = extract_pdf(
        _notice([HEADER, DEADLINE]), document_id="original", filename="scan.pdf",
        ocr_override_pages=(1,),
    )
    assert [line.text for line in doc.lines] == [*HEADER, *DEADLINE]
    assert all(line.evidence.extraction_method == "ocr" for line in doc.lines)


@pytest.mark.parametrize("budget", ["drawings", "quote"])
def test_table_limits_fall_back_to_original_lines(monkeypatch, budget):
    if budget == "drawings":
        monkeypatch.setattr("noticebridge.table_rows.MAX_DRAWING_ITEMS", 3)
    else:
        monkeypatch.setattr("noticebridge.extract.MAX_LINE_CHARACTERS", 25)
    doc = extract_pdf(
        _notice([HEADER, DEADLINE]), document_id="original", filename="original.pdf",
    )
    assert [line.text for line in doc.lines][-2:] == list(DEADLINE)


def test_worker_reports_changed_deadline_and_fee_in_reordered_rows():
    original = _notice([HEADER, DEADLINE, FEE])
    revised = _notice([HEADER, ("Application fee", "Rs. 450"),
                       ("Application deadline", "11 December 2026")])
    with TestClient(app) as client:
        response = client.post("/api/compare", files={
            "original": ("original.pdf", original, "application/pdf"),
            "revised": ("revised.pdf", revised, "application/pdf"),
        })
    assert response.status_code == 200, response.text
    report = response.json()
    assert len(report["findings"]) == len(report["checklist"]) == 2
    for finding, category, old, new in zip(
        report["findings"], ("deadline", "fee"),
        ("2026-12-13", "INR 300.00"), ("2026-12-11", "INR 450.00"), strict=True,
    ):
        assert finding["status"] == "confirmed_change"
        assert finding["category"] == category
        assert not finding["authority_verified"]
        assert finding["original"]["page"] == finding["revised"]["page"] == 1
        assert finding["original"]["bbox"][0] < 265 < finding["original"]["bbox"][2]
        (delta,) = finding["field_changes"]
        assert delta["outcome"] == "changed"
        assert delta["original"]["canonical"] == old
        assert delta["revised"]["canonical"] == new


@pytest.mark.parametrize(("layout", "rotation"), [("rules", 0), ("rectangles", 90)])
def test_clock_cells_keep_label_and_geometry(layout, rotation):
    rows = [
        HEADER, ("Reporting time", "5:30 PM IST"),
        ("Application deadline", "13 December 2026 at 17:00 IST"),
    ]
    pdf = _notice(rows, layout=layout, rotation=rotation)
    doc = extract_pdf(pdf, document_id="original", filename="schedule.pdf")
    assert [line.text for line in doc.lines] == [
        *HEADER, "Reporting time 5:30 PM IST",
        "Application deadline 13 December 2026 at 17:00 IST",
    ]
    for line in doc.lines[2:]:
        assert line.evidence.page == 1
        assert line.evidence.page_rotation == rotation
        assert line.evidence.extraction_method == "native"
        assert line.evidence.bbox[0] < 265 < line.evidence.bbox[2]


@pytest.mark.parametrize(("label", "value"), [
    ("Reference number", "17:00"),
    ("Reporting time", "17:00 to 18:00"),
    ("Reporting time", "5-7 PM"),
    ("Reporting time", "UTC+05:30"),
    ("Reporting time", "17:00+05:30"),
    ("Reporting time", "17:00:30"),
    ("Reporting time", "DOC-17:00"),
    ("Reporting time", "17:00 on request"),
    ("Reporting time at 17:00", "18:00"),
    ("Reporting time", "13 to 15 December 2026 at 17:00"),
    ("Reporting time", "01/02/2026 at 17:00"),
])
def test_unrelated_or_ambiguous_clock_cells_remain_separate(label, value):
    doc = extract_pdf(
        _notice([HEADER, (label, value)]), document_id="original", filename="schedule.pdf",
    )
    assert [line.text for line in doc.lines] == [*HEADER, label, value]


@pytest.mark.parametrize("layout", ["borderless", "fills", "partial_divider"])
def test_clock_cells_require_proven_grid_geometry(layout):
    row = ("Reporting time", "17:00")
    doc = extract_pdf(
        _notice([HEADER, row], layout=layout), document_id="original", filename="schedule.pdf",
    )
    assert [line.text for line in doc.lines] == [*HEADER, *row]


@pytest.mark.parametrize(("old", "new", "outcomes"), [
    ("5:30 PM IST", "17:30 IST", ["same_value"]),
    ("17:30", "18:30", ["changed"]),
    ("5:30", "17:30", ["uncertain"]),
    ("24:00", "18:30", ["uncertain"]),
    ("17:30 UTC+05:30", "18:30 UTC+05:30", ["changed"]),
])
def test_clock_table_roundtrip_through_worker(old, new, outcomes):
    original = _notice([HEADER, ("Reporting time", old)])
    revised = _notice([HEADER, ("Reporting time", new)])
    with TestClient(app) as client:
        response = client.post("/api/compare", files={
            "original": ("original.pdf", original, "application/pdf"),
            "revised": ("revised.pdf", revised, "application/pdf"),
        })
    assert response.status_code == 200, response.text
    report = response.json()
    (finding,) = report["findings"]
    assert finding["status"] == "confirmed_change"
    assert finding["category"] == "time"
    assert finding["original"]["text"] == f"Reporting time {old}"
    assert finding["revised"]["text"] == f"Reporting time {new}"
    assert [delta["outcome"] for delta in finding["field_changes"]] == outcomes
    assert not finding["authority_verified"]
    assert finding["original"]["bbox"][0] < 265 < finding["original"]["bbox"][2]


def test_table_date_and_cutoff_fields_both_survive_reordered_rows():
    from noticebridge.compare import compare_documents

    original = _notice([
        HEADER, ("Application deadline", "13 December 2026 at 17:00 IST"),
        ("Reporting time", "18:00 IST"),
    ])
    revised = _notice([
        HEADER, ("Reporting time", "18:00 IST"),
        ("Application deadline", "14 December 2026 at 16:00 IST"),
    ])
    report = compare_documents(
        extract_pdf(original, document_id="original", filename="original.pdf"),
        extract_pdf(revised, document_id="revised", filename="revised.pdf"),
    )
    (finding,) = report.findings
    assert finding.status == "confirmed_change"
    assert finding.category == "deadline"
    assert [(delta.kind, delta.outcome) for delta in finding.field_changes] == [
        ("date", "changed"), ("time", "changed"),
    ]


@pytest.mark.parametrize(("label_a", "label_b", "value_a", "value_b"), [
    ("Reporting time Shift 1", "Reporting time Shift 2", "17:00 IST", "18:00 IST"),
    ("Reporting time", "Reporting time", "17:00 IST", "18:00 UTC"),
    ("Reporting time", "Reporting time", "13 Dec 2026 at 17:00", "14 Dec 2026 at 18:00"),
])
def test_schedule_table_matching_preserves_scope(label_a, label_b, value_a, value_b):
    from noticebridge.compare import compare_documents

    report = compare_documents(
        extract_pdf(
            _notice([HEADER, (label_a, value_a)]), document_id="original", filename="a.pdf",
        ),
        extract_pdf(
            _notice([HEADER, (label_b, value_b)]), document_id="revised", filename="b.pdf",
        ),
    )
    assert not any(f.status == "confirmed_change" for f in report.findings)
    assert not any(
        delta.outcome == "changed" for f in report.findings for delta in f.field_changes
    )


def test_gate_closing_time_cell_is_joined_without_general_identifier_cells():
    rows = [HEADER, ("Gate closing time", "17:00 IST"), ("Reference number", "18:00")]
    doc = extract_pdf(
        _notice(rows), document_id="original", filename="schedule.pdf",
    )
    assert [line.text for line in doc.lines] == [
        *HEADER, "Gate closing time 17:00 IST", "Reference number", "18:00",
    ]


REVISION_HEADER = ("Activity", "Earlier date", "Revised date")


def test_three_column_revision_keeps_all_printed_cells_and_geometry():
    row = ("Application deadline", "13 December 2026", "19 December 2026")
    doc = extract_pdf(
        _notice([REVISION_HEADER, row], layout="three_columns", rotation=90),
        document_id="revised", filename="revision.pdf",
    )
    assert [line.text for line in doc.lines] == [*REVISION_HEADER, " ".join(row)]
    assert doc.lines[-1].review_only
    evidence = doc.lines[-1].evidence
    assert evidence.page_rotation == 90
    assert evidence.bbox[0] < 265 < 430 < evidence.bbox[2]
    assert any("verify the column headings" in warning for warning in doc.warnings)


@pytest.mark.parametrize("header,row", [
    (("Activity", "Revised date", "Earlier date"),
     ("Application deadline", "13 December 2026", "19 December 2026")),
    (("Activity", "Date", "Date"),
     ("Application deadline", "13 December 2026", "19 December 2026")),
    (REVISION_HEADER, ("Application deadline", "01/02/2026", "19 December 2026")),
    (REVISION_HEADER, ("Reference number", "13 December 2026", "19 December 2026")),
    (REVISION_HEADER, ("Application deadline", "", "19 December 2026")),
])
def test_unproven_revision_rows_keep_individual_cells(header, row):
    doc = extract_pdf(
        _notice([header, row], layout="three_columns"),
        document_id="revised", filename="revision.pdf",
    )
    assert [line.text for line in doc.lines] == [*header, *(value for value in row if value)]
    assert not any(line.review_only for line in doc.lines)
    assert not any("verify the column headings" in warning for warning in doc.warnings)


def test_revision_rows_are_review_only_through_api():
    old = _notice([
        REVISION_HEADER, ("Application deadline", "13 December 2026", "19 December 2026"),
    ], layout="three_columns")
    new = _notice([
        REVISION_HEADER, ("Application deadline", "13 December 2026", "20 December 2026"),
    ], layout="three_columns")
    with TestClient(app) as client:
        response = client.post("/api/compare", files={
            "original": ("original.pdf", old, "application/pdf"),
            "revised": ("revised.pdf", new, "application/pdf"),
        })
    assert response.status_code == 200, response.text
    report = response.json()
    (finding,) = report["findings"]
    assert finding["status"] == "possible_change"
    assert finding["category"] == "deadline"
    assert finding["original"]["text"] == "Application deadline 13 December 2026 19 December 2026"
    assert finding["revised"]["text"] == "Application deadline 13 December 2026 20 December 2026"
    assert not finding["authority_verified"]
    assert all(delta["outcome"] != "changed" for delta in finding["field_changes"])
    assert sum("verify the column headings" in warning for warning in report["warnings"]) == 2


@pytest.mark.parametrize(("header", "row", "kind"), [
    (("Activity", "Earlier fee", "Revised fee"),
     ("Application fee", "Rs. 300", "Rs. 450"), "fee"),
    (("Particulars", "Existing fee", "Updated fee"),
     ("Application fee", "INR 300", "INR 450"), "fee"),
    (("Activity", "Previous time", "Revised time"),
     ("Reporting time", "17:00 IST", "18:30 IST"), "time"),
    (("Schedule", "Original time", "New time"),
     ("Gate closing time", "17:00", "18:30"), "time"),
])
def test_typed_three_column_revision_is_review_only(header, row, kind):
    doc = extract_pdf(
        _notice([header, row], layout="three_columns", rotation=90),
        document_id="revised", filename="revision.pdf",
    )
    assert [line.text for line in doc.lines] == [*header, " ".join(row)]
    assert doc.lines[-1].review_only
    assert doc.lines[-1].evidence.extraction_method == "native"
    assert doc.lines[-1].evidence.page_rotation == 90
    assert doc.lines[-1].evidence.bbox[0] < 265 < 430 < doc.lines[-1].evidence.bbox[2]
    assert any(f"earlier/revised {kind} table" in warning for warning in doc.warnings)


@pytest.mark.parametrize(("header", "row"), [
    (("Activity", "Revised fee", "Earlier fee"),
     ("Application fee", "Rs. 300", "Rs. 450")),
    (("Activity", "Fee", "Fee"),
     ("Application fee", "Rs. 300", "Rs. 450")),
    (("Activity", "Earlier fee", "Revised fee"),
     ("Application fee", "Rs. 3,4", "Rs. 450")),
    (("Activity", "Earlier fee", "Revised fee"),
     ("Application fee", "300", "Rs. 450")),
    (("Activity", "Earlier fee", "Revised fee"),
     ("Application deadline", "Rs. 300", "Rs. 450")),
    (("Activity", "Earlier time", "Revised time"),
     ("Reporting time", "5:30", "18:30")),
    (("Activity", "Earlier time", "Revised time"),
     ("Reporting time", "17:00 to 18:00", "19:00")),
    (("Activity", "Earlier time", "Revised time"),
     ("Application fee", "17:00", "18:00")),
    (("Activity", "Earlier time", "Revised time"),
     ("Reporting time", "", "18:30")),
])
def test_ambiguous_fee_time_revision_leaves_original_cells(header, row):
    doc = extract_pdf(
        _notice([header, row], layout="three_columns"),
        document_id="revised", filename="revision.pdf",
    )
    assert [line.text for line in doc.lines] == [
        *header, *(value for value in row if value),
    ]
    assert not any(line.review_only for line in doc.lines)
    assert not any("earlier/revised fee table" in warning
                   or "earlier/revised time table" in warning for warning in doc.warnings)


@pytest.mark.parametrize(("header", "label", "earlier", "old", "new", "kind"), [
    (("Activity", "Earlier fee", "Revised fee"), "Application fee",
     "Rs. 300", "Rs. 450", "Rs. 500", "fee"),
    (("Activity", "Earlier time", "Revised time"), "Reporting time",
     "17:00 IST", "18:00 IST", "19:00 IST", "time"),
])
def test_fee_time_revision_api_never_confirms_typed_table(
    header, label, earlier, old, new, kind,
):
    original = _notice([header, (label, earlier, old)], layout="three_columns")
    revised = _notice([header, (label, earlier, new)], layout="three_columns")
    with TestClient(app) as client:
        response = client.post("/api/compare", files={
            "original": ("original.pdf", original, "application/pdf"),
            "revised": ("revised.pdf", revised, "application/pdf"),
        })
    assert response.status_code == 200, response.text
    report = response.json()
    quotations = {
        source["text"]
        for finding in report["findings"]
        for source in [finding["original"], finding["revised"], *finding["supporting_evidence"]]
        if source is not None
    }
    assert f"{label} {earlier} {old}" in quotations
    assert f"{label} {earlier} {new}" in quotations
    assert all(finding["status"] != "confirmed_change" for finding in report["findings"])
    assert all(delta["outcome"] != "changed" for finding in report["findings"]
               for delta in finding["field_changes"])
    assert sum(f"earlier/revised {kind} table" in warning
               for warning in report["warnings"]) == 2


@pytest.mark.parametrize(("header", "row_a", "row_b", "kind"), [
    (("Activity", "Earlier fee", "Revised fee"),
     ("Application fee", "Rs. 300", "Rs. 450"),
     ("Exam fee", "Rs. 200", "Rs. 250"), "fee"),
    (("Activity", "Earlier time", "Revised time"),
     ("Reporting time", "17:00 IST", "18:00 IST"),
     ("Exam time", "09:00 IST", "10:00 IST"), "time"),
])
def test_multiple_consecutive_revision_rows_share_one_page_warning(
    header, row_a, row_b, kind,
):
    doc = extract_pdf(
        _notice([header, row_a, row_b], layout="three_columns"),
        document_id="revised", filename="multirow.pdf",
    )
    assert [line.text for line in doc.lines] == [
        *header, " ".join(row_a), " ".join(row_b),
    ]
    assert [line.review_only for line in doc.lines] == [False, False, False, True, True]
    assert sum(f"earlier/revised {kind} table" in warning for warning in doc.warnings) == 1


def test_invalid_revision_row_breaks_header_inheritance():
    header = ("Activity", "Earlier fee", "Revised fee")
    supported = ("Application fee", "Rs. 300", "Rs. 450")
    unsupported = ("Reference number", "Rs. 200", "Rs. 250")
    later = ("Application fee", "Rs. 400", "Rs. 500")
    doc = extract_pdf(
        _notice([header, supported, unsupported, later], layout="three_columns"),
        document_id="original", filename="broken.pdf",
    )
    assert [line.text for line in doc.lines] == [
        *header, " ".join(supported), *unsupported, *later,
    ]
    assert sum(line.review_only for line in doc.lines) == 1
    assert sum("earlier/revised fee table" in warning for warning in doc.warnings) == 1


def test_mixed_typed_revision_sections_keep_distinct_review_warnings():
    fee_header = ("Activity", "Earlier fee", "Revised fee")
    fee_row = ("Application fee", "Rs. 300", "Rs. 450")
    time_header = ("Activity", "Earlier time", "Revised time")
    time_row = ("Reporting time", "17:00", "18:00")
    doc = extract_pdf(
        _notice([fee_header, fee_row, time_header, time_row], layout="three_columns"),
        document_id="original", filename="mixed.pdf",
    )
    assert [line.text for line in doc.lines] == [
        *fee_header, " ".join(fee_row), *time_header, " ".join(time_row),
    ]
    assert sum(line.review_only for line in doc.lines) == 2
    assert sum("earlier/revised fee table" in warning for warning in doc.warnings) == 1
    assert sum("earlier/revised time table" in warning for warning in doc.warnings) == 1


def test_oversized_revision_quote_is_not_merged_or_warned(monkeypatch):
    monkeypatch.setattr("noticebridge.extract.MAX_LINE_CHARACTERS", 30)
    header = ("Activity", "Earlier fee", "Revised fee")
    row = ("Application fee", "Rs. 300", "Rs. 450")
    doc = extract_pdf(
        _notice([header, row], layout="three_columns"),
        document_id="original", filename="quote-limit.pdf",
    )
    assert [line.text for line in doc.lines] == [*header, *row]
    assert not any(line.review_only for line in doc.lines)
    assert not any("earlier/revised fee table" in warning for warning in doc.warnings)
