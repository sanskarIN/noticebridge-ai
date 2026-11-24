"""Use generated scanned bodies and real source PDFs to exercise coverage reporting."""

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pymupdf as fitz
import pytest
from fastapi.testclient import TestClient

from noticebridge.api import app
from noticebridge.compare import compare_documents
from noticebridge.extract import extract_pdf
from noticebridge.provenance import InvalidReportProvenance, verify_report_provenance


def _mixed_notice(day=13, *, rotation=0, layout="mixed"):
    with fitz.open() as picture:
        canvas = picture.new_page(width=540, height=640)
        canvas.insert_text((30, 240), f"Application deadline: {day} December 2026", fontsize=24)
        image = canvas.get_pixmap().tobytes("png")
    with fitz.open() as pdf:
        page = pdf.new_page(width=612, height=792)
        image_rect = (35, 75, 575, 715) if layout != "small" else (40, 80, 200, 230)
        page.insert_image(image_rect, stream=image, keep_proportion=False)
        if layout != "scan":
            page.insert_text((45, 40), "Riverton circular", fontsize=14)
            page.insert_text((300, 110), "Page 1", fontsize=11)
        if layout == "embedded_text":
            page.insert_text((50, 275), "Application deadline: 13 December 2026", fontsize=14)
            page.insert_text(
                (50, 335), "Candidates must submit a signed application form.", fontsize=14,
            )
            page.insert_text((50, 375), "Bring the original identity document.", fontsize=14)
        page.set_rotation(rotation)
        return pdf.tobytes()


@pytest.mark.parametrize("rotation", [0, 90, 270])
def test_native_header_does_not_hide_a_scanned_notice_body(rotation):
    result = extract_pdf(
        _mixed_notice(rotation=rotation), document_id="original", filename="mixed.pdf",
    )
    assert result.summary.pages_without_text == []
    assert result.summary.pages_with_unchecked_images == [1]
    assert result.summary.ocr_pages == []
    assert [line.text for line in result.lines] == ["Riverton circular", "Page 1"]


@pytest.mark.parametrize("layout", ["small", "embedded_text", "scan"])
def test_image_review_is_distinct_from_decorations_existing_text_and_empty_pages(layout):
    result = extract_pdf(
        _mixed_notice(layout=layout), document_id="original", filename="notice.pdf",
    )
    assert result.summary.pages_with_unchecked_images == []
    assert result.summary.pages_without_text == ([1] if layout == "scan" else [])


def test_image_area_is_clipped_to_the_visible_pdf_page():
    with fitz.open(stream=_mixed_notice(), filetype="pdf") as pdf:
        pdf[0].set_cropbox(fitz.Rect(0, 0, 612, 120))
        cropped = pdf.tobytes()
    result = extract_pdf(cropped, document_id="original", filename="cropped.pdf")
    assert result.summary.pages_with_unchecked_images == []
    assert [line.text for line in result.lines] == ["Riverton circular", "Page 1"]


def test_api_returns_page_ids_even_when_native_text_has_no_changes():
    with TestClient(app) as client:
        response = client.post("/api/compare", files={
            "original": ("original.pdf", _mixed_notice(13), "application/pdf"),
            "revised": ("revised.pdf", _mixed_notice(11), "application/pdf"),
        })
    assert response.status_code == 200, response.text
    report = response.json()
    assert report["findings"] == []
    assert report["text_coverage"] == "all_pages_have_text"
    assert [doc["pages_with_unchecked_images"] for doc in report["documents"]] == [[1], [1]]


@pytest.mark.parametrize("invalid_pages", [[0], [3], [1, 1], [2]])
def test_parent_rejects_invalid_image_page_metadata(invalid_pages):
    with fitz.open(stream=_mixed_notice(), filetype="pdf") as pdf:
        pdf.new_page()
        original = pdf.tobytes()
    revised = _mixed_notice()
    report = compare_documents(
        extract_pdf(original, document_id="original", filename="original.pdf"),
        extract_pdf(revised, document_id="revised", filename="revised.pdf"),
    )
    report.documents[0].pages_with_unchecked_images = invalid_pages
    with pytest.raises(InvalidReportProvenance, match="unchecked image pages"):
        verify_report_provenance(
            report, original=original, revised=revised,
            old_name="original.pdf", new_name="revised.pdf",
        )


def test_explicit_ocr_recovers_the_scanned_body_when_language_data_is_installed():
    if not shutil.which("tesseract"):
        pytest.skip("Tesseract command is optional")
    langs = subprocess.run(
        ["tesseract", "--list-langs"], text=True, capture_output=True, check=True,
    ).stdout.splitlines()
    if not {"eng", "hin"}.issubset(langs):
        pytest.skip("English and Hindi OCR data are optional")

    result = extract_pdf(
        _mixed_notice(), document_id="original", filename="mixed.pdf", ocr_override_pages=(1,),
    )
    assert result.summary.pages_with_unchecked_images == []
    assert result.summary.ocr_pages == [1]
    assert any("deadline" in line.text.casefold() for line in result.lines)
    assert all(line.evidence.extraction_method == "ocr" for line in result.lines)


def test_labeled_evaluation_reports_image_pages_per_role_and_cohort(tmp_path):
    (tmp_path / "original.pdf").write_bytes(_mixed_notice(13))
    (tmp_path / "revised.pdf").write_bytes(_mixed_notice(11, layout="small"))
    manifest = tmp_path / "labels.json"
    manifest.write_text(json.dumps({
        "version": 1,
        "cases": [{
            "id": "image-body", "original": "original.pdf",
            "revised": "revised.pdf", "expected_pairs": [],
        }],
    }), encoding="utf-8")
    script = Path(__file__).resolve().parents[1] / "benchmarks" / "evaluate_labeled.py"
    process = subprocess.run(
        [sys.executable, str(script), str(manifest)],
        capture_output=True, text=True, check=True, timeout=30,
    )
    result = json.loads(process.stdout)
    assert result["unchecked_image_page_count"] == 1
    assert result["cases"][0]["unchecked_image_page_numbers"] == {"original": [1], "revised": []}
    assert result["cohorts"]["by_label_method"]["unrecorded"]["unchecked_image_page_count"] == 1


def test_table_join_cannot_hide_unchecked_image_region():
    with fitz.open() as picture:
        page = picture.new_page(width=400, height=770)
        page.insert_text((20, 500), "Scanned instructions", fontsize=20)
        image = page.get_pixmap().tobytes("png")
    labels = [
        "Application deadline phase one",
        "Application deadline phase two",
        "Application deadline phase three",
        "Application deadline phase four",
    ]
    with fitz.open() as pdf:
        page = pdf.new_page(width=612, height=792)
        page.insert_image((200, 10, 600, 780), stream=image, keep_proportion=False)
        for index in range(5):
            y = 60 + index * 38
            page.draw_line((20, y), (590, y))
        for x in (20, 200, 590):
            page.draw_line((x, 60), (x, 212))
        for index, label in enumerate(labels):
            y = 77 + index * 38
            page.insert_text((30, y), label, fontsize=8)
            page.insert_text((420, y), "13 December 2026", fontsize=8)
        data = pdf.tobytes()

    result = extract_pdf(data, document_id="original", filename="mixed-table.pdf")
    assert [line.text for line in result.lines] == [
        f"{label} 13 December 2026" for label in labels
    ]
    assert result.summary.pages_without_text == []
    assert result.summary.pages_with_unchecked_images == [1]


def test_independent_image_coverage_gate_fails_despite_selectable_text(tmp_path):
    old = _mixed_notice(13)
    new = _mixed_notice(11)
    for name, data in (("original.pdf", old), ("revised.pdf", new)):
        (tmp_path / name).write_bytes(data)
    manifest = tmp_path / "labels.json"
    # Fictional fixtures exercise the declared cohort gate; this is not
    # an independently labeled real-world measurement.
    case = {
        "id": "image-body", "source_kind": "consented", "label_method": "independent_human",
        "original": "original.pdf", "revised": "revised.pdf",
        "original_sha256": hashlib.sha256(old).hexdigest(),
        "revised_sha256": hashlib.sha256(new).hexdigest(), "expected_pairs": [],
    }
    manifest.write_text(json.dumps({"version": 2, "cases": [case]}), encoding="utf-8")
    script = Path(__file__).resolve().parents[1] / "benchmarks" / "evaluate_labeled.py"
    command = [
        sys.executable, str(script), str(manifest),
        "--max-independent-incomplete-cases", "0",
        "--max-independent-unchecked-image-cases",
    ]
    strict = subprocess.run(
        [*command, "0"], capture_output=True, text=True, check=False, timeout=30,
    )
    assert strict.returncode == 1, strict.stderr
    report = json.loads(strict.stdout)
    independent = report["cohorts"]["declared_independent_nonfictional"]
    assert independent["incomplete_case_count"] == 0
    assert independent["unchecked_image_case_count"] == 1
    assert independent["unchecked_image_page_count"] == 2
    assert report["unchecked_image_case_count"] == 1
    allowed = subprocess.run(
        [*command, "1"], capture_output=True, text=True, check=False, timeout=30,
    )
    assert allowed.returncode == 0, allowed.stderr
