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
