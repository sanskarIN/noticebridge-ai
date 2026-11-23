import pytest

from noticebridge.extract import InvalidDocument, extract_pdf, parse_ocr_selection


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


def test_invalid_source_box_is_omitted_without_losing_valid_text(pdf_bytes, monkeypatch):
    import pymupdf as fitz

    get_text = fitz.Page.get_text

    def add_invalid_line(page, *args, **kwargs):
        assert kwargs["flags"] & fitz.TEXT_PRESERVE_IMAGES == 0
        result = get_text(page, *args, **kwargs)
        result["blocks"][0]["lines"].append({
            "spans": [{"text": "Unusable text"}],
            "bbox": (9000, 9000, 9010, 9010),
        })
        return result

    monkeypatch.setattr(fitz.Page, "get_text", add_invalid_line)
    document = extract_pdf(
        pdf_bytes([["Usable source text"]]), document_id="original", filename="source.pdf",
    )
    assert [line.text for line in document.lines] == ["Usable source text"]
    assert document.summary.has_extractable_text
    assert any("page 1 omitted 1 text line" in warning for warning in document.warnings)


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
    from noticebridge import extract

    def forbidden(*args, **kwargs):
        raise AssertionError("OCR must not run without opt-in or on native text")

    monkeypatch.setattr(extract, "_extract_ocr_dict", forbidden)
    native = extract_pdf(pdf_bytes([["Exam notice"]]), document_id="original",
                         filename="native.pdf", enable_ocr=True)
    assert native.summary.ocr_page_count == 0
    blank = extract_pdf(pdf_bytes([[]]), document_id="original", filename="blank.pdf")
    assert "OCR not enabled" in blank.warnings[0]


@pytest.mark.parametrize(("selection", "expected"), [
    ("", ()),
    ("३–५, 1, 4", (1, 3, 4, 5)),
    ("  80 , 2-2 ", (2, 80)),
])
def test_parse_selected_ocr_pages(selection, expected):
    assert parse_ocr_selection(selection) == expected


@pytest.mark.parametrize("selection", ["0", "81", "5-3", "1-13", "1,,2", "1,foo", "1" * 161])
def test_reject_invalid_ocr_page_selection(selection):
    with pytest.raises(InvalidDocument):
        parse_ocr_selection(selection)


def test_explicit_ocr_reserves_budget_and_replaces_the_native_layer(pdf_bytes, monkeypatch):
    from noticebridge import extract

    seen_pages = []

    def ocr_dict(page):
        seen_pages.append(page.number + 1)
        return page.get_text("dict", flags=0)

    monkeypatch.setattr(extract, "MAX_OCR_PAGES", 2)
    monkeypatch.setattr(extract, "_extract_ocr_dict", ocr_dict)
    result = extract_pdf(
        pdf_bytes([[], [], ["Selected OCR passage"], ["Unselected native passage"]]),
        document_id="original", filename="notice.pdf", enable_ocr=True, ocr_override_pages=(3,),
    )
    assert seen_pages == [1, 3]
    assert result.summary.ocr_override_pages == [3]
    assert result.summary.ocr_pages == [3]
    assert result.summary.ocr_page_count == 1
    assert result.summary.pages_without_text == [1, 2]
    assert [(line.evidence.page, line.evidence.extraction_method) for line in result.lines] == [
        (3, "ocr"), (4, "native"),
    ]


def test_selected_ocr_failure_leaves_the_unreliable_native_layer_uncovered(
    pdf_bytes, monkeypatch,
):
    from noticebridge import extract

    def failed(page, **options):
        raise RuntimeError("OCR unavailable")

    monkeypatch.setattr(extract, "_extract_ocr_dict", failed)
    result = extract_pdf(
        pdf_bytes([["Unreliable native text"], ["Keep this"]]),
        document_id="revised", filename="notice.pdf", ocr_override_pages=(1,),
    )
    assert [line.text for line in result.lines] == ["Keep this"]
    assert result.summary.ocr_override_pages == [1]
    assert result.summary.ocr_pages == []
    assert result.summary.pages_without_text == [1]
    assert any("page 1 OCR unavailable" in warning for warning in result.warnings)


def test_ocr_render_budget_counts_rounded_dimensions(monkeypatch):
    import pymupdf as fitz

    from noticebridge import extract

    monkeypatch.setattr(extract, "OCR_DPI", 72)
    monkeypatch.setattr(extract, "MAX_OCR_RENDER_PIXELS", 100)
    assert extract._within_ocr_pixel_budget(fitz.Rect(0, 0, 10, 10))
    assert not extract._within_ocr_pixel_budget(fitz.Rect(0, 0, 9.1, 10.1))


def test_missing_tesseract_is_reported_not_fabricated(pdf_bytes, monkeypatch):
    from noticebridge import extract

    def unavailable(*args, **kwargs):
        raise RuntimeError("Tesseract unavailable")

    monkeypatch.setattr(extract, "_extract_ocr_dict", unavailable)
    document = extract_pdf(pdf_bytes([[]]), document_id="original",
                           filename="scan.pdf", enable_ocr=True)
    assert not document.lines
    assert document.summary.ocr_page_count == 0
    assert any("OCR unavailable" in warning for warning in document.warnings)


def test_per_document_ocr_budget_is_visible(pdf_bytes, monkeypatch):
    from noticebridge import extract

    def unavailable(*args, **kwargs):
        raise RuntimeError("simulated OCR failure")

    monkeypatch.setattr(extract, "_extract_ocr_dict", unavailable)
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


def test_rotated_scaled_ocr_boxes_overlap_the_visible_source():
    import shutil
    import subprocess

    import pymupdf as fitz

    if not shutil.which("tesseract"):
        pytest.skip("Tesseract CLI is optional")
    languages = subprocess.run(
        ["tesseract", "--list-langs"], check=True, capture_output=True, text=True,
    ).stdout.splitlines()
    if not {"eng", "hin"}.issubset(languages):
        pytest.skip("Tesseract English and Hindi data are required")

    with fitz.open() as document:
        for rotation, position in (
            (0, (140, 200)), (90, (240, 570)), (180, (490, 400)), (270, (240, 180)),
        ):
            page = document.new_page(width=610, height=700)
            page.insert_text(
                position, "Application deadline: 14 December 2026", fontsize=20, rotate=rotation,
            )
            page.set_cropbox(fitz.Rect(55, 55, 555, 660))
            page.set_rotation(rotation)
            document.xref_set_key(page.xref, "UserUnit", "2")
        payload = document.tobytes()
    native = extract_pdf(payload, document_id="original", filename="native.pdf")
    recovered = extract_pdf(
        payload, document_id="original", filename="native.pdf",
        ocr_override_pages=(1, 2, 3, 4),
    )
    assert recovered.summary.ocr_pages == [1, 2, 3, 4]
    for source, ocr in zip(native.lines, recovered.lines, strict=True):
        assert ocr.evidence.page == source.evidence.page
        assert ocr.evidence.page_rotation == source.evidence.page_rotation
        assert "14 December 2026" in " ".join(ocr.text.split())
        native_box, ocr_box = fitz.Rect(source.evidence.bbox), fitz.Rect(ocr.evidence.bbox)
        area = min(native_box.get_area(), ocr_box.get_area())
        assert (native_box & ocr_box).get_area() > area * 0.8


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
    from noticebridge import extract

    def unavailable(*args, **kwargs):
        raise RuntimeError("Tesseract unavailable")

    monkeypatch.setattr(extract, "_extract_ocr_dict", unavailable)
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

