"""Opt-in local selected-page OCR export. No network or automatic model download."""

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from .chat_ocr_protocol import (
    MAX_REPORT_BYTES,
    OcrReviewError,
    encode_report,
    validate_report,
    validate_selection,
)
from .compare_cli import CliError, _destination, _input_pdf, _publish_report
from .extract import MAX_UPLOAD_BYTES, InvalidDocument, parse_ocr_selection
from .isolation import (
    OCR_TIMEOUT_SECONDS,
    ProcessingFailed,
    _attach_windows_job,
    _kill_worker,
    _strict_worker_json,
    _worker_environment,
)


def run_ocr_review(source: bytes, role: str, pages: list[int]) -> dict:
    pages = validate_selection(pages)
    if not source or len(source) > MAX_UPLOAD_BYTES or role not in ("original", "revised"):
        raise OcrReviewError("Invalid OCR source")
    payload = json.dumps({
        "source": base64.b64encode(source).decode("ascii"), "role": role, "pages": pages,
    }).encode("ascii")
    try:
        with tempfile.TemporaryFile(mode="w+b") as output:
            process = subprocess.Popen(
                [sys.executable, "-m", "noticebridge.chat_ocr_worker"],
                stdin=subprocess.PIPE, stdout=output, stderr=subprocess.DEVNULL,
                env=_worker_environment(), start_new_session=os.name == "posix",
            )
            job = _attach_windows_job(process)
            try:
                try:
                    process.communicate(input=payload, timeout=OCR_TIMEOUT_SECONDS)
                except BaseException:
                    if job is None or not job.terminate():
                        _kill_worker(process)
                    try:
                        process.communicate(timeout=2)
                    except (OSError, subprocess.TimeoutExpired):
                        pass
                    raise
                if process.returncode != 0:
                    raise OcrReviewError("Local OCR worker failed")
                output.seek(0)
                data = output.read(MAX_REPORT_BYTES + 1)
            finally:
                if job is not None:
                    job.close()
    except (OSError, subprocess.TimeoutExpired, ProcessingFailed) as exc:
        raise OcrReviewError("Local OCR worker failed or exceeded its time limit") from exc
    if len(data) > MAX_REPORT_BYTES:
        raise OcrReviewError("OCR review exceeds file limit")
    try:
        raw = _strict_worker_json(data)
    except ProcessingFailed as exc:
        raise OcrReviewError("Invalid OCR worker result") from exc
    return validate_report(raw, source, role, pages)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--role", choices=("original", "revised"), required=True)
    parser.add_argument("--pages", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--allow-local-processing", action="store_true")
    args = parser.parse_args(argv)
    try:
        if not args.allow_local_processing:
            raise OcrReviewError("Explicit local processing consent is required")
        pages = list(parse_ocr_selection(args.pages))
        if not pages:
            raise OcrReviewError("Select at least one physical page")
        _destination(args.output)
        source = _input_pdf(args.source, args.role)
        report = run_ocr_review(source, args.role, pages)
        _publish_report(args.output, encode_report(report))
    except (CliError, InvalidDocument, OcrReviewError):
        print("OCR review failed. Check consent, selected pages, local OCR and output path.",
              file=sys.stderr)
        return 2
    print(json.dumps({
        "pages": len(report["pages"]),
        "pages_with_text": sum(bool(page["lines"]) for page in report["pages"]),
        "lines": sum(len(page["lines"]) for page in report["pages"]),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
