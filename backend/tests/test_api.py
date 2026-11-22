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
