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


@pytest.mark.parametrize(("payload", "error_text"), [
    (b"not a pdf", "recognized as a PDF"),
    (b"%PDF- invalid", "Malformed or unreadable PDF"),
])
def test_worker_validation_error_is_preserved(pdf_bytes, payload, error_text):
    good = pdf_bytes([["Hello"]])
    with pytest.raises(InvalidDocument, match=error_text):
        _run(payload, good)


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
    monkeypatch.setattr(module, "_attach_windows_job", lambda p: None)
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
        def __init__(self, stdout):
            self.returncode = returncode
            self.stdout = stdout

        def communicate(self, **kwargs):
            self.stdout.write(output)
            self.stdout.flush()
            return None, None

    monkeypatch.setattr(
        module.subprocess, "Popen", lambda *a, **kw: Process(kw["stdout"])
    )
    monkeypatch.setattr(module, "_attach_windows_job", lambda p: None)
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

        def __init__(self, stdout):
            self.stdout = stdout

        def communicate(self, **kwargs):
            self.stdout.write(json.dumps({
                "error": "invalid_document", "message": "Malformed or unreadable PDF"
            }).encode())
            self.stdout.flush()
            return None, None

    monkeypatch.setattr(
        module.subprocess, "Popen", lambda *a, **kw: Process(kw["stdout"])
    )
    monkeypatch.setattr(module, "_attach_windows_job", lambda p: None)
    good = pdf_bytes([["Text"]])
    with pytest.raises(InvalidDocument, match="Malformed"):
        _run(good, good)


def test_worker_environment_excludes_unrelated_secrets(monkeypatch):
    import noticebridge.isolation as module

    monkeypatch.setenv("OPENAI_API_KEY", "secret-sentinel")
    monkeypatch.setenv("GITHUB_TOKEN", "another-secret")
    monkeypatch.setenv("PATH", "/usr/bin")
    environment = module._worker_environment()
    assert environment["PATH"] == "/usr/bin"
    assert "OPENAI_API_KEY" not in environment
    assert "GITHUB_TOKEN" not in environment


def test_subprocess_bootstrap_receives_ocr_budget(monkeypatch, pdf_bytes):
    import noticebridge.isolation as module

    commands: list[list[str]] = []

    class Process:
        returncode = 0

        def __init__(self, stdout):
            self.stdout = stdout

        def communicate(self, **kwargs):
            self.stdout.write(
                b'{"error":"invalid_document","message":"not a valid PDF"}'
            )
            self.stdout.flush()
            return None, None

    def start(command, **kwargs):
        commands.append(command)
        return Process(kwargs["stdout"])

    monkeypatch.setattr(module.subprocess, "Popen", start)
    monkeypatch.setattr(module, "_attach_windows_job", lambda p: None)
    pdf = pdf_bytes([["Hello"]])
    with pytest.raises(InvalidDocument):
        run_isolated_comparison(
            pdf, pdf, old_name="a.pdf", new_name="b.pdf", enable_ocr=True
        )
    assert commands[0][-2:] == ["noticebridge.worker_entry", "--ocr"]


def test_bootstrap_rejects_unknown_modes(monkeypatch):
    from noticebridge import worker_entry

    monkeypatch.setattr("sys.argv", ["python", "--unsupported"])
    assert worker_entry.main() == 2


def test_worker_output_is_read_only_up_to_limit_plus_one(monkeypatch, pdf_bytes):
    import noticebridge.isolation as module

    monkeypatch.setattr(module, "MAX_RESULT_BYTES", 64)

    class NoisyProcess:
        returncode = 0

        def __init__(self, stdout):
            self.stdout = stdout

        def communicate(self, **kwargs):
            self.stdout.write(b"X" * 1024)
            self.stdout.flush()
            return None, None

    monkeypatch.setattr(
        module.subprocess, "Popen",
        lambda *args, **kwargs: NoisyProcess(kwargs["stdout"]),
    )
    monkeypatch.setattr(module, "_attach_windows_job", lambda p: None)
    pdf = pdf_bytes([["One line"]])
    with pytest.raises(ProcessingFailed, match="result exceeded the safety limit"):
        _run(pdf, pdf)


def test_worker_stdout_capture_is_not_a_memory_pipe(monkeypatch, pdf_bytes):
    import noticebridge.isolation as module

    original_popen = module.subprocess.Popen
    captured = []

    def record(*args, **kwargs):
        stdout = kwargs["stdout"]
        assert stdout is not subprocess.PIPE
        assert callable(stdout.write)
        assert stdout.fileno() >= 0
        captured.append(True)
        return original_popen(*args, **kwargs)

    monkeypatch.setattr(module.subprocess, "Popen", record)
    pdf = pdf_bytes([["Deadline: 13 December 2026"]])
    report = _run(pdf, pdf)
    assert report.documents[0].page_count == 1
    assert captured == [True]


def test_containment_failure_never_sends_untrusted_pdf_bytes(monkeypatch, pdf_bytes):
    """Fail closed if the Windows worker cannot be assigned to a job."""
    import noticebridge.isolation as module

    class MockProcess:
        def __init__(self):
            self.communicate_called = False

        def communicate(self, **kwargs):
            self.communicate_called = True
            raise AssertionError("uncontained worker must not receive PDF bytes")

    process = MockProcess()
    monkeypatch.setattr(module.subprocess, "Popen", lambda *a, **kw: process)

    def unavailable(_):
        raise ProcessingFailed("Windows worker process containment unavailable")

    monkeypatch.setattr(module, "_attach_windows_job", unavailable)
    pdf = pdf_bytes([["One"]])
    with pytest.raises(ProcessingFailed, match="containment unavailable"):
        _run(pdf, pdf)
    assert not process.communicate_called


def test_timeout_terminates_job_and_closes_handle(monkeypatch, pdf_bytes):
    import noticebridge.isolation as module

    class MockJob:
        terminated = False
        closed = False

        def terminate(self):
            self.terminated = True
            return True

        def close(self):
            self.closed = True

    class HungProcess:
        def __init__(self):
            self.calls = 0

        def communicate(self, **kwargs):
            self.calls += 1
            if self.calls == 1:
                raise subprocess.TimeoutExpired("noticebridge.worker", 1)
            return None, None

    job = MockJob()
    process = HungProcess()
    monkeypatch.setattr(module.subprocess, "Popen", lambda *a, **kw: process)
    monkeypatch.setattr(module, "_attach_windows_job", lambda _: job)
    monkeypatch.setattr(
        module, "_kill_worker",
        lambda _: (_ for _ in ()).throw(AssertionError("job termination expected")),
    )
    pdf = pdf_bytes([["One"]])
    with pytest.raises(ProcessingTimedOut):
        _run(pdf, pdf)
    assert job.terminated and job.closed
    assert process.calls == 2

