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
    assert len(response.json()["documents"][0]["sha256"]) == 64


def test_blank_pdfs_do_not_claim_successful_comparison(pdf_bytes):
    response = client.post("/api/compare", files={
        "original": ("empty1.pdf", pdf_bytes([[]]), "application/pdf"),
        "revised": ("empty2.pdf", pdf_bytes([[]]), "application/pdf"),
    })
    assert response.status_code == 200
    data = response.json()
    assert not data["findings"]
    assert all(not document["has_extractable_text"] for document in data["documents"])
    assert any("comparison is incomplete" in warning for warning in data["warnings"])


def test_display_filename_filters_bidi_and_ascii_controls():
    from noticebridge.api import safe_filename

    assert (
        safe_filename("C:\\private\\\u202ecorrected.pdf", fallback="original.pdf")
        == "corrected.pdf"
    )
    assert safe_filename("\r\n", fallback="original.pdf") == "original.pdf"
    assert safe_filename("सूचना.pdf", fallback="original.pdf") == "सूचना.pdf"
