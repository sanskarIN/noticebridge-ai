import pytest

from noticebridge.extract import InvalidDocument, extract_pdf


def test_real_page_and_bbox(pdf_bytes):
    document = extract_pdf(
        pdf_bytes([["Exam notice"], ["Last date: 14 December 2026"]]),
        document_id="original", filename="notice.pdf",
    )
    assert document.summary.page_count == 2
    assert document.summary.line_count == 2
    assert document.lines[1].evidence.page == 2
    x0, y0, x1, y1 = document.lines[1].evidence.bbox
    assert 0 <= x0 < x1 and 0 <= y0 < y1
    assert document.lines[1].evidence.filename == "notice.pdf"


@pytest.mark.parametrize("payload", [b"", b"not a pdf", b"%PDF- definitely not a pdf"])
def test_rejects_invalid_pdf(payload):
    with pytest.raises(InvalidDocument):
        extract_pdf(payload, document_id="original", filename="x.pdf")


def test_scanned_page_emits_warning(pdf_bytes):
    d = extract_pdf(pdf_bytes([[]]), document_id="original", filename="scan.pdf")
    assert not d.summary.has_extractable_text
    assert "OCR not enabled" in d.warnings[0]


def test_rejects_pdf_with_too_many_pages():
    import pymupdf as fitz

    pdf = fitz.open()
    for _ in range(81):
        pdf.new_page()
    data = pdf.tobytes()
    pdf.close()
    with pytest.raises(InvalidDocument, match="1 to 80 pages"):
        extract_pdf(data, document_id="original", filename="huge.pdf")


def test_rejects_password_protected_pdf():
    import pymupdf as fitz

    pdf = fitz.open()
    pdf.new_page()
    payload = pdf.tobytes(
        encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="secret", user_pw="secret"
    )
    pdf.close()
    with pytest.raises(InvalidDocument, match="Encrypted"):
        extract_pdf(payload, document_id="original", filename="protected.pdf")


def test_source_digest_and_native_provenance(pdf_bytes):
    import hashlib

    payload = pdf_bytes([["Deadline: 13 December 2026"]])
    doc = extract_pdf(payload, document_id="revised", filename="source.pdf")
    assert doc.summary.sha256 == hashlib.sha256(payload).hexdigest()
    assert doc.summary.ocr_page_count == 0
    assert doc.lines[0].evidence.extraction_method == "native"


def test_ocr_is_opt_in_and_skips_native_text(pdf_bytes, monkeypatch):
    import pymupdf as fitz

    def forbidden(*args, **kwargs):
        raise AssertionError("OCR must not run without opt-in or on native text")

    monkeypatch.setattr(fitz.Page, "get_textpage_ocr", forbidden)
    native = extract_pdf(pdf_bytes([["Exam notice"]]), document_id="original",
                         filename="native.pdf", enable_ocr=True)
    assert native.summary.ocr_page_count == 0
    blank = extract_pdf(pdf_bytes([[]]), document_id="original", filename="blank.pdf")
    assert "OCR not enabled" in blank.warnings[0]


def test_missing_tesseract_is_reported_not_fabricated(pdf_bytes, monkeypatch):
    import pymupdf as fitz

    def unavailable(*args, **kwargs):
        raise RuntimeError("Tesseract unavailable")

    monkeypatch.setattr(fitz.Page, "get_textpage_ocr", unavailable)
    document = extract_pdf(pdf_bytes([[]]), document_id="original",
                           filename="scan.pdf", enable_ocr=True)
    assert not document.lines
    assert document.summary.ocr_page_count == 0
    assert any("OCR unavailable" in warning for warning in document.warnings)


def test_per_document_ocr_budget_is_visible(pdf_bytes, monkeypatch):
    import pymupdf as fitz

    from noticebridge import extract

    def unavailable(*args, **kwargs):
        raise RuntimeError("simulated OCR failure")

    monkeypatch.setattr(fitz.Page, "get_textpage_ocr", unavailable)
    monkeypatch.setattr(extract, "MAX_OCR_PAGES", 1)
    document = extract_pdf(pdf_bytes([[], [], []]), document_id="revised",
                           filename="scan.pdf", enable_ocr=True)
    assert any("limit of 1 pages reached" in warning for warning in document.warnings)


def test_oversized_ocr_page_is_skipped(pdf_bytes, monkeypatch):
    from noticebridge import extract

    monkeypatch.setattr(extract, "MAX_OCR_RENDER_PIXELS", 1)
    document = extract_pdf(pdf_bytes([[]]), document_id="original",
                           filename="scan.pdf", enable_ocr=True)
    assert document.summary.ocr_page_count == 0
    assert any("OCR pixel limit" in warning for warning in document.warnings)


def test_real_scanned_pdf_gets_ocr_when_installed():
    import shutil
    import subprocess

    import pymupdf as fitz

    if shutil.which("tesseract") is None:
        pytest.skip("Tesseract CLI not installed on this host")
    languages = subprocess.run(["tesseract", "--list-langs"], check=True,
                               capture_output=True, text=True).stdout
    if not {"eng", "hin"}.issubset(set(languages.splitlines())):
        pytest.skip("Tesseract eng and hin language packs are required")

    original = fitz.open()
    page = original.new_page(width=610, height=170)
    page.insert_text((25, 85), "Application deadline: 15 December 2026", fontsize=21)
    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
    scanned = fitz.open()
    scanned_page = scanned.new_page(width=610, height=170)
    scanned_page.insert_image(scanned_page.rect, stream=pix.tobytes("png"))
    original.close()
    payload = scanned.tobytes()
    scanned.close()

    without_ocr = extract_pdf(payload, document_id="original", filename="scan.pdf")
    assert without_ocr.summary.line_count == 0
    result = extract_pdf(payload, document_id="original", filename="scan.pdf",
                         enable_ocr=True)
    assert result.summary.ocr_page_count == 1
    assert any("deadline" in item.text.lower() for item in result.lines)
    assert all(item.evidence.extraction_method == "ocr" for item in result.lines)
    assert any("transcription can be inaccurate" in warning for warning in result.warnings)


def test_rotated_source_geometry_is_marked_for_viewer():
    import pymupdf as fitz

    document = fitz.open()
    page = document.new_page(width=300, height=600)
    page.insert_text((35, 70), "Official notice", fontsize=14)
    page.set_rotation(90)
    payload = document.tobytes()
    document.close()
    extracted = extract_pdf(payload, document_id="revised", filename="rotated.pdf")
    assert extracted.lines
    evidence = extracted.lines[0].evidence
    assert evidence.page_rotation == 90
    assert evidence.page_width == 600
    assert evidence.page_height == 300
    assert evidence.extraction_method == "native"


def test_real_hindi_scan_ocr_with_installed_language_pack():
    """Optional integration smoke test: all text must come from raster OCR."""
    import shutil
    import subprocess
    from io import BytesIO
    from pathlib import Path

    import pymupdf as fitz

    if not shutil.which("tesseract"):
        pytest.skip("Tesseract is optional")
    langs = subprocess.run(["tesseract", "--list-langs"], check=True,
                           capture_output=True, text=True).stdout
    if not {"eng", "hin"}.issubset(set(langs.splitlines())):
        pytest.skip("Both OCR language packs are required")
    image_module = pytest.importorskip("PIL.Image")
    draw_module = pytest.importorskip("PIL.ImageDraw")
    font_module = pytest.importorskip("PIL.ImageFont")

    font_path = Path("/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf")
    if not font_path.exists():
        pytest.skip("Fixture font not available")
    image = image_module.new("RGB", (1700, 260), "white")
    drawer = draw_module.Draw(image)
    font = font_module.truetype(str(font_path), 46)
    drawer.text((35, 45), "अंतिम तिथि १५ दिसंबर २०२६", fill="black",
                font=font, language="hi")
    buffer = BytesIO()
    image.save(buffer, "PNG")
    document = fitz.open()
    page = document.new_page(width=850, height=130)
    page.insert_image(page.rect, stream=buffer.getvalue())
    payload = document.tobytes()
    document.close()

    result = extract_pdf(payload, document_id="original", filename="hindi.pdf",
                         enable_ocr=True)
    assert result.summary.ocr_page_count == 1
    assert result.lines
    assert all(line.evidence.extraction_method == "ocr" for line in result.lines)
    # Correct Hindi OCR is a quality benchmark, not guaranteed: readers still
    # need to verify numbers against the scanned original.


def test_ocr_missing_text_warning_retains_document_and_page(pdf_bytes, monkeypatch):
    import pymupdf

    def unavailable(*args, **kwargs):
        raise RuntimeError("Tesseract unavailable")

    monkeypatch.setattr(pymupdf.Page, "get_textpage_ocr", unavailable)
    document = extract_pdf(
        pdf_bytes([[]]), document_id="original", filename="scanned.pdf",
        enable_ocr=True,
    )
    assert any(
        "original: page 1 has no extractable text; comparison may be incomplete" in warning
        for warning in document.warnings
    )


def test_text_coverage_tracks_blank_pages_without_claiming_equivalence(pdf_bytes):
    document = extract_pdf(
        pdf_bytes([["Deadline: 13 December 2026"], [], ["Fee: Rs. 100"]]),
        document_id="original", filename="mixed.pdf",
    )
    assert document.summary.page_count == 3
    assert document.summary.pages_with_text == 2
    assert document.summary.pages_without_text == [2]
    assert any("page 2 has no extractable text" in w for w in document.warnings)


def test_blank_pdf_has_zero_text_covered_pages(pdf_bytes):
    document = extract_pdf(pdf_bytes([[], []]), document_id="revised", filename="blank.pdf")
    assert document.summary.pages_with_text == 0
    assert document.summary.pages_without_text == [1, 2]

