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
    import fitz

    pdf = fitz.open()
    for _ in range(81):
        pdf.new_page()
    data = pdf.tobytes()
    pdf.close()
    with pytest.raises(InvalidDocument, match="1 to 80 pages"):
        extract_pdf(data, document_id="original", filename="huge.pdf")


def test_rejects_password_protected_pdf():
    import fitz

    pdf = fitz.open()
    pdf.new_page()
    payload = pdf.tobytes(
        encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="secret", user_pw="secret"
    )
    pdf.close()
    with pytest.raises(InvalidDocument, match="Encrypted"):
        extract_pdf(payload, document_id="original", filename="protected.pdf")
