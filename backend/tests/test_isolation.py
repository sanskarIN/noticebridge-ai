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




def _simulate_worker_output(monkeypatch, content: bytes) -> None:
    """Run the real parent validation against controlled subprocess stdout."""
    import noticebridge.isolation as module

    class Process:
        returncode = 0

        def __init__(self, stdout):
            self.stdout = stdout

        def communicate(self, **kwargs):
            self.stdout.write(content)
            self.stdout.flush()
            return None, None

    monkeypatch.setattr(module.subprocess, "Popen", lambda *a, **kw: Process(kw["stdout"]))
    monkeypatch.setattr(module, "_attach_windows_job", lambda _: None)


@pytest.mark.parametrize("message", [
    "Malformed or unreadable PDF",
    "File is not recognized as a PDF",
    "Encrypted PDFs are not supported",
])
def test_worker_preserves_only_approved_document_errors(monkeypatch, pdf_bytes, message):
    _simulate_worker_output(
        monkeypatch, json.dumps({"error": "invalid_document", "message": message}).encode(),
    )
    pdf = pdf_bytes([["Notice"]])
    with pytest.raises(InvalidDocument, match=message):
        _run(pdf, pdf)


def test_worker_sanitizes_bounded_selected_ocr_page_failure(monkeypatch, pdf_bytes):
    _simulate_worker_output(
        monkeypatch, json.dumps({
            "error": "invalid_document",
            "message": "OCR page 12 is outside the revised PDF (2 pages)",
        }).encode(),
    )
    pdf = pdf_bytes([["Notice"]])
    with pytest.raises(InvalidDocument, match="Selected OCR page is outside"):
        _run(pdf, pdf)


@pytest.mark.parametrize("bad_output", [
    b'{"error":"invalid_document","message":"Confidential source: applicant 123"}',
    b'{"error":"invalid_document","message":"Malformed or unreadable PDF","extra":true}',
    b'{"error":"invalid_document","message":"Malformed or unreadable PDF",'
    b'"message":"Confidential source"}',
    b'{"error":"invalid_document","message":NaN}',
    b'{"error":"invalid_document","message":"Malformed or unreadable PDF",'
    b'"detail":1e9999}',
    b'{"error":"unrecognized","message":"Malformed or unreadable PDF"}',
    b'["invalid_document"]',
    b'{"error":"invalid_document","message":42}',
])
def test_worker_rejects_untrusted_error_envelopes_without_leaking_text(
    monkeypatch, pdf_bytes, bad_output,
):
    _simulate_worker_output(monkeypatch, bad_output)
    pdf = pdf_bytes([["Notice"]])
    with pytest.raises(ProcessingFailed) as result:
        _run(pdf, pdf)
    assert "Confidential source" not in str(result.value)
    assert "applicant 123" not in str(result.value)


@pytest.mark.parametrize("mutation", [
    "extra_root", "extra_evidence", "missing_default", "string_page",
    "boolean_page", "duplicate_member", "nonfinite", "overflow_float",
])
def test_worker_report_wire_schema_rejects_coercion_and_unexpected_claims(
    monkeypatch, pdf_bytes, mutation,
):
    from noticebridge.compare import compare_documents
    from noticebridge.extract import extract_pdf

    first = pdf_bytes([["Deadline: 13 December 2026"]])
    second = pdf_bytes([["Deadline: 14 December 2026"]])
    report = compare_documents(
        extract_pdf(first, document_id="original", filename="original.pdf"),
        extract_pdf(second, document_id="revised", filename="revised.pdf"),
    )
    payload = report.model_dump(mode="json")
    finding = payload["findings"][0]
    evidence = finding["original"]
    if mutation == "extra_root":
        payload["officially_verified"] = True
    elif mutation == "extra_evidence":
        evidence["issuer_verified"] = True
    elif mutation == "missing_default":
        del finding["authority_verified"]
    elif mutation == "string_page":
        evidence["page"] = "1"
    elif mutation == "boolean_page":
        evidence["page"] = True
    elif mutation == "nonfinite":
        finding["similarity"] = float("nan")
    elif mutation == "overflow_float":
        finding["similarity"] = float("inf")
    output = json.dumps(payload).encode()
    if mutation == "duplicate_member":
        output = output.replace(
            b'"documents":', b'"documents": [], "documents":', 1,
        )
    _simulate_worker_output(monkeypatch, output)
    with pytest.raises(ProcessingFailed, match="worker returned"):
        _run(first, second)


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


@pytest.mark.parametrize("with_job", [False, True])
def test_worker_broken_pipe_kills_and_reaps_process_tree(
    monkeypatch, pdf_bytes, with_job
):
    import noticebridge.isolation as module

    events = []

    class Process:
        def __init__(self):
            self.calls = 0

        def communicate(self, **kwargs):
            self.calls += 1
            if self.calls == 1:
                raise BrokenPipeError("simulated broken pipe during worker input")
            events.append("reaped")
            return None, None

    class Job:
        def terminate(self):
            events.append("job_terminated")
            return True

        def close(self):
            events.append("job_closed")

    process = Process()
    monkeypatch.setattr(module.subprocess, "Popen", lambda *a, **kw: process)
    monkeypatch.setattr(module, "_attach_windows_job", lambda _: Job() if with_job else None)
    monkeypatch.setattr(module, "_kill_worker", lambda _: events.append("worker_killed"))
    payload = pdf_bytes([["Deadline: 13 December 2026"]])
    with pytest.raises(ProcessingFailed, match="could not start"):
        _run(payload, payload)
    assert process.calls == 2
    assert "reaped" in events
    if with_job:
        assert events == ["job_terminated", "reaped", "job_closed"]
    else:
        assert events == ["worker_killed", "reaped"]


def test_temporary_worker_output_is_closed_after_communication_error(
    monkeypatch, pdf_bytes
):
    import noticebridge.isolation as module

    create_file = module.tempfile.TemporaryFile
    tracked = []

    class TrackedFile:
        def __init__(self):
            self.inner = create_file(mode="w+b")
            self.closed = False
            tracked.append(self)

        def __enter__(self):
            return self.inner

        def __exit__(self, exc_type, exc, traceback):
            self.inner.close()
            self.closed = True

    class BrokenProcess:
        def __init__(self):
            self.calls = 0

        def communicate(self, **kwargs):
            self.calls += 1
            if self.calls == 1:
                raise OSError("simulated worker input pipe failure")
            return None, None

    process = BrokenProcess()
    monkeypatch.setattr(module.tempfile, "TemporaryFile", lambda **kw: TrackedFile())
    monkeypatch.setattr(module.subprocess, "Popen", lambda *a, **kw: process)
    monkeypatch.setattr(module, "_attach_windows_job", lambda _: None)
    monkeypatch.setattr(module, "_kill_worker", lambda _: None)
    pdf = pdf_bytes([["Deadline: 13 December 2026"]])
    with pytest.raises(ProcessingFailed):
        _run(pdf, pdf)
    assert tracked and all(output.closed for output in tracked)
    assert process.calls == 2

