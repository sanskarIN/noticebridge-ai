"""Multipart ambiguity and validation privacy at the PDF API boundary."""

import pytest
from fastapi.testclient import TestClient

from noticebridge import api


@pytest.fixture
def guarded_client(monkeypatch):
    def unexpected_worker(*args, **kwargs):
        pytest.fail("An invalid or ambiguous form reached the PDF worker")

    monkeypatch.setattr(api, "run_isolated_comparison", unexpected_worker)
    with TestClient(api.app) as client:
        yield client


def _files(pdf_bytes):
    pdf = pdf_bytes([["Application deadline: 13 December 2026"]])
    return [
        ("original", ("original.pdf", pdf, "application/pdf")),
        ("revised", ("revised.pdf", pdf, "application/pdf")),
    ]


def _assert_private_rejection(response, detail, private=""):
    assert response.status_code == 422, response.text
    assert response.json() == {"detail": detail}
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    if private:
        assert private not in response.text


AMBIGUOUS = "Unexpected or repeated comparison form field"
INVALID = "Invalid comparison form: provide two PDFs and valid comparison options"


@pytest.mark.parametrize("role", ["original", "revised"])
def test_duplicate_file_roles_are_rejected(guarded_client, pdf_bytes, role):
    files = _files(pdf_bytes)
    files.append((role, ("private-third.pdf", b"%PDF-ambiguous", "application/pdf")))
    _assert_private_rejection(
        guarded_client.post("/api/compare", files=files), AMBIGUOUS, "private-third.pdf",
    )


@pytest.mark.parametrize(("option", "first", "second"), [
    ("enable_ocr", "false", "true"),
    ("enable_ocr", "true", "false"),
    ("enable_semantic", "false", "true"),
    ("enable_semantic", "true", "false"),
    ("enable_semantic", "true", "true"),
    ("original_ocr_pages", "1", "2"),
    ("revised_ocr_pages", "", "1"),
])
def test_repeated_options_never_select_one_value(
    guarded_client, pdf_bytes, option, first, second,
):
    files = _files(pdf_bytes) + [(option, (None, first)), (option, (None, second))]
    _assert_private_rejection(guarded_client.post("/api/compare", files=files), AMBIGUOUS)


@pytest.mark.parametrize("as_file", [False, True])
def test_unknown_fields_are_rejected_without_echoing_names(
    guarded_client, pdf_bytes, as_file,
):
    private = "private-extra-field"
    value = ("extra.pdf", b"%PDF-extra", "application/pdf") if as_file else (None, "text")
    files = _files(pdf_bytes) + [(private, value)]
    _assert_private_rejection(
        guarded_client.post("/api/compare", files=files), AMBIGUOUS, private,
    )


@pytest.mark.parametrize("option", ["enable_ocr", "enable_semantic"])
def test_invalid_boolean_does_not_echo_submitted_value(
    guarded_client, pdf_bytes, option,
):
    private = "private-invalid-boolean-value"
    files = _files(pdf_bytes) + [(option, (None, private))]
    _assert_private_rejection(
        guarded_client.post("/api/compare", files=files), INVALID, private,
    )


@pytest.mark.parametrize("role", ["original", "revised"])
def test_text_instead_of_pdf_is_not_reflected(guarded_client, pdf_bytes, role):
    private = "private-notice-text"
    files = [(key, (None, private) if key == role else part)
             for key, part in _files(pdf_bytes)]
    _assert_private_rejection(
        guarded_client.post("/api/compare", files=files), INVALID, private,
    )


@pytest.mark.parametrize("role", ["original", "revised"])
def test_missing_required_pdf_returns_safe_error(guarded_client, pdf_bytes, role):
    files = [(key, part) for key, part in _files(pdf_bytes) if key != role]
    _assert_private_rejection(guarded_client.post("/api/compare", files=files), INVALID)


def test_empty_form_is_rejected_without_worker(guarded_client):
    _assert_private_rejection(guarded_client.post("/api/compare"), INVALID)


def test_rejected_request_does_not_prevent_subsequent_valid_comparison(pdf_bytes):
    files = _files(pdf_bytes)
    with TestClient(api.app) as client:
        invalid = files + [("enable_semantic", (None, "false")),
                           ("enable_semantic", (None, "true"))]
        _assert_private_rejection(client.post("/api/compare", files=invalid), AMBIGUOUS)
        response = client.post("/api/compare", files=files)
        assert response.status_code == 200, response.text
        assert response.json()["semantic_assistance"] == "not_requested"
        assert response.json()["automatic_ocr"] is False


@pytest.mark.parametrize("option", [
    "enable_ocr", "enable_semantic", "original_ocr_pages", "revised_ocr_pages",
])
def test_file_parts_cannot_supply_text_options(guarded_client, pdf_bytes, option):
    files = _files(pdf_bytes) + [
        (option, ("private-options.txt", b"true", "text/plain")),
    ]
    _assert_private_rejection(
        guarded_client.post("/api/compare", files=files), INVALID, "private-options.txt",
    )


@pytest.mark.parametrize("option", ["enable_ocr", "enable_semantic"])
@pytest.mark.parametrize("value", ["", "1", "0", "yes", "no", "on", "off", "TRUE", " true "])
def test_noncanonical_boolean_values_are_rejected(
    guarded_client, pdf_bytes, option, value,
):
    files = _files(pdf_bytes) + [(option, (None, value))]
    _assert_private_rejection(guarded_client.post("/api/compare", files=files), INVALID)


@pytest.mark.parametrize(("ocr", "semantic"), [
    ("false", "false"), ("true", "false"), ("false", "true"), ("true", "true"),
])
def test_only_explicit_canonical_consent_is_forwarded(
    monkeypatch, pdf_bytes, ocr, semantic,
):
    recorded = []
    runner = api.run_isolated_comparison

    def record(*args, **kwargs):
        recorded.append((kwargs["enable_ocr"], kwargs["enable_semantic"]))
        # The test verifies consent routing without invoking optional AI or OCR.
        kwargs.update(enable_ocr=False, enable_semantic=False)
        return runner(*args, **kwargs)

    monkeypatch.setattr(api, "run_isolated_comparison", record)
    files = _files(pdf_bytes) + [
        ("enable_ocr", (None, ocr)), ("enable_semantic", (None, semantic)),
    ]
    with TestClient(api.app) as client:
        response = client.post("/api/compare", files=files)
    assert response.status_code == 200, response.text
    assert recorded == [(ocr == "true", semantic == "true")]
