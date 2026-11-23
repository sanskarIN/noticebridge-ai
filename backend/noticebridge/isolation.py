"""Disposable PDF comparison worker with a wall-clock processing deadline.

This is process separation, not a security sandbox. Public internet deployments
still need OS-level sandboxing, authentication, rate limiting and monitoring.
"""

import base64
import json
import os
import signal
import subprocess
import sys

from pydantic import ValidationError

from .extract import MAX_UPLOAD_BYTES, InvalidDocument
from .models import ComparisonReport

NATIVE_TIMEOUT_SECONDS = 45
OCR_TIMEOUT_SECONDS = 120
MAX_RESULT_BYTES = 64 * 1024 * 1024


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


def run_isolated_comparison(
    original: bytes,
    revised: bytes,
    *,
    old_name: str,
    new_name: str,
    enable_ocr: bool,
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
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    timeout = OCR_TIMEOUT_SECONDS if enable_ocr else NATIVE_TIMEOUT_SECONDS
    try:
        process = subprocess.Popen(
            [sys.executable, "-m", "noticebridge.worker"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=os.name == "posix",
        )
        try:
            output, _ = process.communicate(input=payload, timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            _kill_worker(process)
            try:
                process.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            raise ProcessingTimedOut("PDF comparison exceeded its processing time limit") from exc
    except OSError as exc:
        raise ProcessingFailed("PDF comparison worker could not start") from exc

    if process.returncode != 0:
        raise ProcessingFailed("PDF comparison worker failed")
    if len(output) > MAX_RESULT_BYTES:
        raise ProcessingFailed("PDF comparison result exceeded the safety limit")
    try:
        result = json.loads(output)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProcessingFailed("PDF comparison worker returned invalid JSON") from exc
    if isinstance(result, dict) and result.get("error") == "invalid_document":
        message = result.get("message")
        raise InvalidDocument(message if isinstance(message, str) else "Invalid PDF document")
    try:
        return ComparisonReport.model_validate(result)
    except ValidationError as exc:
        raise ProcessingFailed("PDF comparison worker returned invalid evidence") from exc
