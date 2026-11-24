"""Disposable PDF comparison worker with a wall-clock processing deadline.

This is process separation, not a security sandbox. Public internet deployments
still need OS-level sandboxing, authentication, rate limiting and monitoring.
"""

import base64
import json
import math
import os
import re
import signal
import subprocess
import sys
import tempfile

from pydantic import ValidationError

from .extract import MAX_UPLOAD_BYTES, InvalidDocument, validate_ocr_pages
from .models import ComparisonReport
from .provenance import InvalidReportProvenance, verify_report_provenance
from .windows_job import WindowsWorkerJob

NATIVE_TIMEOUT_SECONDS = 45
OCR_TIMEOUT_SECONDS = 120
SEMANTIC_TIMEOUT_SECONDS = 110
OCR_SEMANTIC_TIMEOUT_SECONDS = 210
MAX_RESULT_BYTES = 64 * 1024 * 1024

# A parser subprocess is a lower-trust producer. Only the known, bounded
# document-validation strings are safe to include in a user-facing 422 response.
# Arbitrary worker-controlled text could expose private passages through API logs.
SAFE_WORKER_DOCUMENT_ERRORS = frozenset({
    "Malformed comparison request",
    "Invalid document encoding",
    "Each PDF must be nonempty and at most 10 MiB",
    "Comparison request exceeds the size limit",
    "PDF must be nonempty and at most 10 MiB",
    "File is not recognized as a PDF",
    "Invalid document role",
    "Malformed or unreadable PDF",
    "Encrypted PDFs are not supported",
    "PDF must contain 1 to 80 pages",
    "PDF contains an excessively long text line",
    "PDF contains too many text lines",
    "PDF contains too much extractable text",
    "Comparison result exceeds the safety limit",
    "Select at most 12 OCR pages per PDF",
    "OCR page numbers must be between 1 and 80",
    "OCR page numbers must be unique",
})
_OCR_PAGE_ERROR = re.compile(
    r"OCR page [1-9][0-9]? is outside the (?:original|revised) PDF "
    r"\\([1-9][0-9]? pages\\)",
    re.ASCII,
)


def _strict_worker_json(output: bytes) -> dict:
    """Decode the bounded subprocess stream without ambiguous JSON semantics."""
    def unique_members(pairs: list[tuple[str, object]]) -> dict:
        fields = {}
        for key, value in pairs:
            if key in fields:
                raise ProcessingFailed("PDF comparison worker returned duplicate JSON fields")
            fields[key] = value
        return fields

    def nonfinite(_: str) -> None:
        raise ProcessingFailed("PDF comparison worker returned a non-finite number")

    def finite_float(raw: str) -> float:
        value = float(raw)
        if not math.isfinite(value):
            raise ProcessingFailed("PDF comparison worker returned a non-finite number")
        return value

    try:
        result = json.loads(
            output, object_pairs_hook=unique_members,
            parse_constant=nonfinite, parse_float=finite_float,
        )
    except ProcessingFailed:
        raise
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise ProcessingFailed("PDF comparison worker returned invalid JSON") from exc
    if type(result) is not dict:
        raise ProcessingFailed("PDF comparison worker returned an invalid response")
    return result


def _same_wire_values(raw: object, expected: object) -> bool:
    """Reject extra, missing or type-coerced claims at every nesting level."""
    if isinstance(expected, dict):
        return (
            isinstance(raw, dict)
            and raw.keys() == expected.keys()
            and all(_same_wire_values(raw[key], value) for key, value in expected.items())
        )
    if isinstance(expected, list):
        return (
            isinstance(raw, list)
            and len(raw) == len(expected)
            and all(_same_wire_values(a, b) for a, b in zip(raw, expected, strict=True))
        )
    # Integral JSON numbers are also valid encodings of numeric float fields.
    # Do not let bool (a subclass of int) pass through as a number.
    if type(expected) is float:
        return type(raw) in (int, float) and raw == expected
    return type(raw) is type(expected) and raw == expected


def _worker_document_error(response: dict) -> InvalidDocument:
    """Accept only known safe parser errors; never echo arbitrary worker text."""
    if set(response) != {"error", "message"} or response.get("error") != "invalid_document":
        raise ProcessingFailed("PDF comparison worker returned an invalid error response")
    message = response["message"]
    if type(message) is not str:
        raise ProcessingFailed("PDF comparison worker returned an invalid error response")
    if message in SAFE_WORKER_DOCUMENT_ERRORS:
        return InvalidDocument(message)
    if _OCR_PAGE_ERROR.fullmatch(message):
        return InvalidDocument("Selected OCR page is outside the PDF")
    raise ProcessingFailed("PDF comparison worker returned an untrusted error response")


# Explicitly avoid forwarding unrelated service credentials or cloud tokens to
# a process parsing untrusted PDF data. Runtime libraries and Tesseract need
# selected path, locale and temporary-directory settings.
WORKER_ENV_KEYS = (
    "PATH", "PYTHONPATH", "VIRTUAL_ENV", "SYSTEMROOT", "WINDIR",
    "TESSDATA_PREFIX", "LANG", "LC_ALL", "LC_CTYPE",
    "TMPDIR", "TMP", "TEMP", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH",
    "PYTHONUTF8", "PYTHONIOENCODING", "NOTICEBRIDGE_LOCAL_MODEL",
)


def _worker_environment() -> dict[str, str]:
    return {key: os.environ[key] for key in WORKER_ENV_KEYS if key in os.environ}



class ProcessingTimedOut(RuntimeError):
    """A document worker exceeded the configured wall-clock deadline."""


class ProcessingFailed(RuntimeError):
    """A worker crashed or returned an invalid response."""


def _kill_worker(process: subprocess.Popen[bytes]) -> None:
    """Stop the worker (and its process group on POSIX) after a timeout."""
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGKILL)
            return
        except ProcessLookupError:
            return
        except OSError:
            pass
    try:
        process.kill()
    except ProcessLookupError:
        pass


def _attach_windows_job(process: subprocess.Popen[bytes]) -> WindowsWorkerJob | None:
    """Constrain Windows workers before sending any untrusted PDF bytes."""
    if os.name != "nt":
        return None
    try:
        return WindowsWorkerJob(process.pid)
    except Exception as exc:
        # An unexpected ctypes/Win32 setup exception must not strand a
        # newly spawned, unassigned worker. The PDF bytes are still unread.
        _kill_worker(process)
        try:
            process.communicate(timeout=2)
        except (subprocess.TimeoutExpired, OSError):
            pass
        raise ProcessingFailed("Windows worker process containment unavailable") from exc


def run_isolated_comparison(
    original: bytes,
    revised: bytes,
    *,
    old_name: str,
    new_name: str,
    enable_ocr: bool,
    enable_semantic: bool = False,
    original_ocr_pages: tuple[int, ...] = (),
    revised_ocr_pages: tuple[int, ...] = (),
) -> ComparisonReport:
    """Parse and compare both PDFs outside the API process.

    The OS process is disposable and never receives server credentials through
    arguments. A timed-out worker cannot keep the request waiting indefinitely.
    """
    if (
        not original
        or not revised
        or len(original) > MAX_UPLOAD_BYTES
        or len(revised) > MAX_UPLOAD_BYTES
    ):
        raise InvalidDocument("Each PDF must be nonempty and at most 10 MiB")
    original_ocr_pages = validate_ocr_pages(original_ocr_pages)
    revised_ocr_pages = validate_ocr_pages(revised_ocr_pages)
    uses_ocr = enable_ocr or bool(original_ocr_pages or revised_ocr_pages)
    payload = json.dumps(
        {
            "original": {
                "filename": old_name,
                "base64": base64.b64encode(original).decode("ascii"),
            },
            "revised": {
                "filename": new_name,
                "base64": base64.b64encode(revised).decode("ascii"),
            },
            "enable_ocr": enable_ocr,
            "enable_semantic": enable_semantic,
            "original_ocr_pages": original_ocr_pages,
            "revised_ocr_pages": revised_ocr_pages,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    if enable_semantic:
        timeout = OCR_SEMANTIC_TIMEOUT_SECONDS if uses_ocr else SEMANTIC_TIMEOUT_SECONDS
    else:
        timeout = OCR_TIMEOUT_SECONDS if uses_ocr else NATIVE_TIMEOUT_SECONDS
    try:
        # Real stdout is redirected to a private temporary file rather than
        # subprocess.PIPE: communicate() otherwise accumulates unbounded worker
        # output in API memory *before* we can enforce MAX_RESULT_BYTES.
        # The worker itself caps JSON output and POSIX RLIMIT_FSIZE is a second
        # limit. Public Windows hosting still requires OS disk quotas.
        with tempfile.TemporaryFile(mode="w+b") as output_file:
            process = subprocess.Popen(
                [sys.executable, "-m", "noticebridge.worker_entry",
                 "--ocr" if uses_ocr else "--native"],
                stdin=subprocess.PIPE,
                stdout=output_file,
                stderr=subprocess.DEVNULL,
                env=_worker_environment(),
                start_new_session=os.name == "posix",
            )
            job = _attach_windows_job(process)
            try:
                try:
                    # Nothing from the uploaded PDF reaches the worker until
                    # Windows job assignment succeeds.
                    process.communicate(input=payload, timeout=timeout)
                except subprocess.TimeoutExpired as exc:
                    if job is None or not job.terminate():
                        _kill_worker(process)
                    try:
                        process.communicate(timeout=2)
                    except (subprocess.TimeoutExpired, OSError):
                        pass
                    raise ProcessingTimedOut(
                        "PDF comparison exceeded its processing time limit"
                    ) from exc
                except BaseException:
                    # Broken pipes, interrupted writes and other unexpected
                    # failures must also kill/reap the child process tree.
                    # The normal completion path below only handles success.
                    if job is None or not job.terminate():
                        _kill_worker(process)
                    try:
                        process.communicate(timeout=2)
                    except (subprocess.TimeoutExpired, OSError):
                        pass
                    raise

                if process.returncode != 0:
                    raise ProcessingFailed("PDF comparison worker failed")
                output_file.seek(0)
                output = output_file.read(MAX_RESULT_BYTES + 1)
            finally:
                # Closing the job also terminates surviving OCR descendants.
                if job is not None:
                    job.close()
    except OSError as exc:
        raise ProcessingFailed("PDF comparison worker could not start") from exc

    if len(output) > MAX_RESULT_BYTES:
        raise ProcessingFailed("PDF comparison result exceeded the safety limit")
    result = _strict_worker_json(output)
    if "error" in result:
        raise _worker_document_error(result)
    # The worker emits the complete ComparisonReport schema, including default
    # fields. Pydantic otherwise silently ignores unknown keys and can coerce
    # values; neither is acceptable at the subprocess trust boundary.
    if result.keys() != ComparisonReport.model_fields.keys():
        raise ProcessingFailed("PDF comparison worker returned a noncanonical report")
    try:
        report = ComparisonReport.model_validate(result)
        if not _same_wire_values(result, report.model_dump(mode="json")):
            raise ProcessingFailed("PDF comparison worker returned a noncanonical report")
        verify_report_provenance(
            report, original=original, revised=revised,
            old_name=old_name, new_name=new_name,
            semantic_requested=enable_semantic, ocr_requested=enable_ocr,
            original_ocr_pages=original_ocr_pages, revised_ocr_pages=revised_ocr_pages,
        )
        # Record the actual request setting, including runs where OCR yielded no text.
        return report.model_copy(update={"automatic_ocr": enable_ocr})
    except (ValidationError, InvalidReportProvenance) as exc:
        raise ProcessingFailed("PDF comparison worker returned invalid evidence") from exc
