import pytest
from fastapi.testclient import TestClient

from noticebridge.api import app

client = TestClient(app)


def test_health():
    assert client.get("/api/health").json()["status"] == "ok"


def test_compare_endpoint(pdf_bytes):
    res = client.post("/api/compare", files={
        "original": ("old.pdf", pdf_bytes([["Last date: 01/12/2026"]]), "application/pdf"),
        "revised": ("new.pdf", pdf_bytes([["Last date: 09/12/2026"]]), "application/pdf"),
    })
    assert res.status_code == 200, res.text
    payload = res.json()
    assert payload["findings"][0]["status"] == "confirmed_change"
    assert payload["findings"][0]["original"]["page"] == 1
    assert payload["documents"][0]["id"] == "original"
    assert payload["text_coverage"] == "all_pages_have_text"
    assert payload["automatic_ocr"] is False
    assert payload["documents"][0]["pages_with_text"] == 1
    assert payload["documents"][0]["pages_without_text"] == []


def test_bad_input_rejected(pdf_bytes):
    res = client.post("/api/compare", files={
        "original": ("old.pdf", b"not a pdf", "application/pdf"),
        "revised": ("new.pdf", pdf_bytes([["Hello"]]), "application/pdf"),
    })
    assert res.status_code == 422


def test_non_pdf_filename_rejected(pdf_bytes):
    res = client.post("/api/compare", files={
        "original": ("a.txt", b"text", "text/plain"),
        "revised": ("b.pdf", pdf_bytes([["Hello"]]), "application/pdf"),
    })
    assert res.status_code == 415


def test_api_response_is_not_cacheable(pdf_bytes):
    res = client.post("/api/compare", files={
        "original": ("a.pdf", pdf_bytes([["Deadline: 13 December 2026"]]), "application/pdf"),
        "revised": ("b.pdf", pdf_bytes([["Deadline: 14 December 2026"]]), "application/pdf"),
    })
    assert res.status_code == 200
    assert res.headers["cache-control"] == "no-store"
    assert res.headers["x-content-type-options"] == "nosniff"
    field = res.json()["findings"][0]["field_changes"][0]
    assert field["kind"] == "date"
    assert field["outcome"] == "changed"


def test_api_rejects_too_large_upload(pdf_bytes):
    res = client.post("/api/compare", files={
        "original": ("a.pdf", b"%PDF-" + b"0" * (10 * 1024 * 1024), "application/pdf"),
        "revised": ("b.pdf", pdf_bytes([["Hello"]]), "application/pdf"),
    })
    assert res.status_code == 413


def test_api_strips_untrusted_paths_from_filenames(pdf_bytes):
    res = client.post("/api/compare", files={
        "original": (
            "C:\\sensitive\\old.pdf",
            pdf_bytes([["Deadline: 13 Dec 2026"]]),
            "application/pdf",
        ),
        "revised": ("b.pdf", pdf_bytes([["Deadline: 14 Dec 2026"]]), "application/pdf"),
    })
    assert res.status_code == 200
    assert res.json()["documents"][0]["filename"] == "old.pdf"


def test_api_ocr_form_flag_is_forwarded(pdf_bytes, monkeypatch):
    import noticebridge.api as module

    original = module.run_isolated_comparison
    enabled: list[bool] = []

    def record(*args, **kwargs):
        enabled.append(kwargs.get("enable_ocr", False))
        return original(*args, **kwargs)

    monkeypatch.setattr(module, "run_isolated_comparison", record)
    response = client.post("/api/compare", data={"enable_ocr": "true"}, files={
        "original": ("a.pdf", pdf_bytes([["Hello"]]), "application/pdf"),
        "revised": ("b.pdf", pdf_bytes([["World"]]), "application/pdf"),
    })
    assert response.status_code == 200
    assert enabled == [True]
    assert response.json()["automatic_ocr"] is True
    assert len(response.json()["documents"][0]["sha256"]) == 64


@pytest.mark.parametrize(("selection", "error"), [
    ("3-2", "Original notice: OCR ranges"),
    ("2", "outside the original PDF"),
])
def test_ocr_selection_errors_include_the_document_role(pdf_bytes, selection, error):
    pdf = pdf_bytes([["Deadline: 13 December 2026"]])
    response = client.post("/api/compare", data={"original_ocr_pages": selection}, files={
        "original": ("a.pdf", pdf, "application/pdf"),
        "revised": ("b.pdf", pdf, "application/pdf"),
    })
    assert response.status_code == 422
    assert error in response.json()["detail"]


def test_full_ocr_recovers_visible_text_when_the_embedded_mapping_is_wrong():
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

    def notice(date, malformed_mapping=False):
        with fitz.open() as document:
            page = document.new_page(width=600, height=200)
            page.insert_text((40, 90), f"Application deadline: {date} December 2026", fontsize=24)
            if malformed_mapping:
                font_xref = page.get_fonts()[0][0]
                cmap = document.get_new_xref()
                document.update_object(cmap, "<< >>")
                document.update_stream(cmap, b"""
/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Scrambled def /CMapType 2 def
1 begincodespacerange <00> <FF> endcodespacerange
2 beginbfrange <41> <5A> <0061> <61> <7A> <0044> endbfrange
endcmap CMapName currentdict /CMap defineresource pop end end""")
                document.xref_set_key(font_xref, "ToUnicode", f"{cmap} 0 R")
            return document.tobytes()

    original, updated = notice(13), notice(14, malformed_mapping=True)
    files = {
        "original": ("a.pdf", original, "application/pdf"),
        "revised": ("b.pdf", updated, "application/pdf"),
    }
    baseline = client.post("/api/compare", files=files)
    assert baseline.status_code == 200
    assert all(
        finding["revised"] is None or "Application deadline" not in finding["revised"]["text"]
        for finding in baseline.json()["findings"]
    )
    response = client.post("/api/compare", files=files, data={"revised_ocr_pages": "१"})
    assert response.status_code == 200, response.text
    output = response.json()
    assert output["documents"][0]["ocr_pages"] == []
    assert output["documents"][1]["ocr_override_pages"] == [1]
    assert output["documents"][1]["ocr_pages"] == [1]
    finding, = output["findings"]
    assert finding["status"] == "possible_change"
    assert finding["revised"]["extraction_method"] == "ocr"
    delta, = finding["field_changes"]
    assert delta["revised"]["canonical"] == "2026-12-14"
    assert delta["outcome"] == "uncertain"


def test_blank_pdfs_do_not_claim_successful_comparison(pdf_bytes):
    response = client.post("/api/compare", files={
        "original": ("empty1.pdf", pdf_bytes([[]]), "application/pdf"),
        "revised": ("empty2.pdf", pdf_bytes([[]]), "application/pdf"),
    })
    assert response.status_code == 200
    data = response.json()
    assert not data["findings"]
    assert all(not document["has_extractable_text"] for document in data["documents"])
    assert data["text_coverage"] == "inconclusive"
    assert all(document["pages_without_text"] == [1] for document in data["documents"])
    assert any("comparison is incomplete" in warning for warning in data["warnings"])


def test_display_filename_filters_bidi_and_ascii_controls():
    from noticebridge.api import safe_filename

    assert (
        safe_filename("C:\\private\\\u202ecorrected.pdf", fallback="original.pdf")
        == "corrected.pdf"
    )
    assert safe_filename("\r\n", fallback="original.pdf") == "original.pdf"
    assert safe_filename("सूचना.pdf", fallback="original.pdf") == "सूचना.pdf"


def test_local_ai_is_explicit_opt_in(pdf_bytes, monkeypatch):
    import noticebridge.api as module

    original_runner = module.run_isolated_comparison
    captured: list[bool] = []

    def record(*args, **kwargs):
        captured.append(kwargs.get("enable_semantic", False))
        # Test the API switch without contacting any optional Ollama service.
        kwargs["enable_semantic"] = False
        return original_runner(*args, **kwargs)

    monkeypatch.setattr(module, "run_isolated_comparison", record)
    pdf = pdf_bytes([["Application deadline: 13 December 2026"]])
    for form, expected in [({}, False), ({"enable_semantic": "true"}, True)]:
        response = client.post("/api/compare", data=form, files={
            "original": ("a.pdf", pdf, "application/pdf"),
            "revised": ("b.pdf", pdf, "application/pdf"),
        })
        assert response.status_code == 200
        assert response.json()["semantic_assistance"] == "not_requested"
        assert captured[-1] is expected


@pytest.mark.parametrize(("provided", "expected"), [
    ("private／folder／visible.pdf", "visible.pdf"),
    ("C:＼\u005cprivate＼\u005cvisible.pdf", "visible.pdf"),
    ("folder／a.pdf", "a.pdf"),
])
def test_unicode_compatibility_separators_are_stripped_before_display(
    provided, expected,
):
    from noticebridge.api import safe_filename

    assert safe_filename(provided, fallback="original.pdf") == expected


def test_unicode_path_confusables_cannot_spoof_report_filenames(pdf_bytes):
    response = client.post("/api/compare", files={
        "original": (
            "C:＼secret／old.pdf",
            pdf_bytes([["Deadline: 13 December 2026"]]),
            "application/pdf",
        ),
        "revised": (
            "private／new.pdf",
            pdf_bytes([["Deadline: 14 December 2026"]]),
            "application/pdf",
        ),
    })
    assert response.status_code == 200
    payload = response.json()
    assert [doc["filename"] for doc in payload["documents"]] == ["old.pdf", "new.pdf"]
    for finding in payload["findings"]:
        if finding["original"]:
            assert finding["original"]["filename"] == "old.pdf"
        if finding["revised"]:
            assert finding["revised"]["filename"] == "new.pdf"


def test_very_long_safe_filename_retains_pdf_extension():
    from noticebridge.api import safe_filename

    sanitized = safe_filename("a" * 240 + ".pdf", fallback="original.pdf")
    assert len(sanitized) == 200
    assert sanitized.endswith(".pdf")
    assert sanitized.count(".pdf") == 1
