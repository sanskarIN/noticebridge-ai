"""Process-isolation contract: real subprocess plus controlled failure paths."""

import json
import subprocess

import pytest
from fastapi.testclient import TestClient

from noticebridge.api import app
from noticebridge.extract import InvalidDocument
from noticebridge.isolation import (
    ProcessingFailed,
    ProcessingTimedOut,
    run_isolated_comparison,
)


def _run(a, b, **kwargs):
    return run_isolated_comparison(
        a, b, old_name="original.pdf", new_name="revised.pdf",
        enable_ocr=False, **kwargs,
    )


def test_real_worker_roundtrip_retains_evidence(pdf_bytes):
    old = pdf_bytes([["Deadline: 13 December 2026"]])
    new = pdf_bytes([["Deadline: 14 December 2026"]])
    report = _run(old, new)
    assert report.documents[0].filename == "original.pdf"
    assert report.documents[1].sha256
    assert report.findings[0].status == "confirmed_change"
    assert report.findings[0].original.page == 1
    assert report.findings[0].revised.page == 1
    assert report.findings[0].field_changes[0].outcome == "changed"


def test_worker_validation_error_is_preserved(pdf_bytes):
    good = pdf_bytes([["Hello"]])
    with pytest.raises(InvalidDocument, match="recognized as a PDF"):
        _run(b"%PDF- invalid", good)


def test_worker_process_timeout_is_bounded(monkeypatch, pdf_bytes):
    import noticebridge.isolation as module

    class HungProcess:
        pid = 2345

        def __init__(self):
            self.calls = 0

        def communicate(self, *args, **kwargs):
            self.calls += 1
            if self.calls == 1:
                raise subprocess.TimeoutExpired("noticebridge.worker", kwargs["timeout"])
            return (b"", None)

        def kill(self):
            pass

    process = HungProcess()
    monkeypatch.setattr(module.subprocess, "Popen", lambda *a, **kw: process)
    monkeypatch.setattr(module, "_kill_worker", lambda p: None)
    good = pdf_bytes([["Text"]])
    with pytest.raises(ProcessingTimedOut):
        _run(good, good)
    assert process.calls == 2


@pytest.mark.parametrize(
    ("returncode", "output"),
    [(1, b""), (0, b"not json"), (0, b"{}"), (0, b"[]")],
)
def test_worker_crash_or_untrusted_output_is_rejected(monkeypatch, pdf_bytes, returncode, output):
    import noticebridge.isolation as module

    class Process:
        def __init__(self):
            self.returncode = returncode

        def communicate(self, **kwargs):
            return output, None

    monkeypatch.setattr(module.subprocess, "Popen", lambda *a, **kw: Process())
    good = pdf_bytes([["Text"]])
    with pytest.raises(ProcessingFailed):
        _run(good, good)


@pytest.mark.parametrize(("error", "status"), [
    (ProcessingTimedOut("timeout"), 504),
    (ProcessingFailed("worker unavailable"), 503),
])
def test_api_does_not_leak_worker_errors(monkeypatch, pdf_bytes, error, status):
    import noticebridge.api as module

    def fail(*args, **kwargs):
        raise error

    monkeypatch.setattr(module, "run_isolated_comparison", fail)
    good = pdf_bytes([["Hello"]])
    response = TestClient(app).post("/api/compare", files={
        "original": ("old.pdf", good, "application/pdf"),
        "revised": ("new.pdf", good, "application/pdf"),
    })
    assert response.status_code == status
    assert "timeout" not in response.text or status == 504
    assert "worker unavailable" not in response.text


def test_worker_failure_response_is_validated(monkeypatch, pdf_bytes):
    import noticebridge.isolation as module

    class Process:
        returncode = 0

        def communicate(self, **kwargs):
            return json.dumps({
                "error": "invalid_document", "message": "Malformed or unreadable PDF"
            }).encode(), None

    monkeypatch.setattr(module.subprocess, "Popen", lambda *a, **kw: Process())
    good = pdf_bytes([["Text"]])
    with pytest.raises(InvalidDocument, match="Malformed"):
        _run(good, good)
