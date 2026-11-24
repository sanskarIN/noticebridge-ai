"""Local, non-networking notice comparison to an immutable, replayable JSON file.

Run with: python -m noticebridge.compare_cli original.pdf revised.pdf --output report.json

The CLI calls the same disposable worker and parent report-provenance verifier as
the HTTP API. The output includes quoted source evidence and must be kept private.
The terminal only receives summary counters and hashes, never source passages.
An already-existing report is NEVER overwritten. Browser/Ollama integration is
not required; experimental semantic suggestions are deliberately unavailable.
"""

import argparse
import hashlib
import json
import os
import sys
import tempfile
from collections import Counter
from pathlib import Path

from .api import safe_filename
from .extract import MAX_UPLOAD_BYTES, InvalidDocument, parse_ocr_selection
from .isolation import ProcessingFailed, ProcessingTimedOut, run_isolated_comparison
from .models import ComparisonReport

MAX_REPORT_BYTES = 64 * 1024 * 1024
REPORT_SUFFIX = ".json"
ERROR_LIMIT = 300


class CliError(ValueError):
    """A sanitized, user-actionable error without source quotations."""


def _input_pdf(path: Path, role: str) -> bytes:
    """Read bounded source bytes without trusting extension or file metadata."""
    if path.suffix.casefold() != ".pdf":
        raise CliError(f"The {role} source must have a .pdf filename.")
    try:
        with path.open("rb") as source:
            data = source.read(MAX_UPLOAD_BYTES + 1)
    except OSError as exc:
        raise CliError(f"Unable to read the {role} source PDF.") from exc
    if not data:
        raise CliError(f"The {role} source PDF is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise CliError(f"The {role} source PDF exceeds 10 MiB.")
    if not data.lstrip().startswith(b"%PDF-"):
        raise CliError(f"The {role} source is not recognized as a PDF.")
    return data


def _destination(path: Path) -> None:
    """Preflight only; _publish_report checks no-overwrite again atomically."""
    if path.suffix.casefold() != REPORT_SUFFIX:
        raise CliError("The output path must end in .json.")
    if path.exists() or path.is_symlink():
        raise CliError("The output already exists. Select a new JSON filename.")
    if not path.parent.is_dir():
        raise CliError("The output parent directory does not exist.")


def _publish_report(path: Path, content: bytes) -> None:
    """Publish a private, complete report only if the destination does not exist.

    Create a mode-0600 temporary file in the destination directory, then use
    an atomic same-filesystem hard link with exclusive destination creation.
    This avoids clobbering files even when another process races the preflight.
    We deliberately fail closed on volumes without hard-link support rather
    than risk a partial or overwritten saved evidence report.
    """
    _destination(path)
    if not content or len(content) > MAX_REPORT_BYTES:
        raise CliError("The generated report exceeds the local export safety limit.")
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w+b", prefix=".noticebridge-", suffix=".tmp", dir=path.parent,
            delete=False,
        ) as stream:
            temporary = Path(stream.name)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        # os.link fails with EEXIST even if another process creates the target
        # after _destination. It never replaces pre-existing files or symlinks.
        os.link(temporary, path)
    except FileExistsError as exc:
        raise CliError("The output already exists. Select a new JSON filename.") from exc
    except OSError as exc:
        raise CliError("Unable to write an atomic private evidence report.") from exc
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                # The report, if successfully published, is still complete.
                pass


def _summary(report: ComparisonReport, payload: bytes) -> dict:
    counts = Counter(finding.status for finding in report.findings)
    return {
        "format": "noticebridge-local-comparison-summary",
        "source_fingerprints": {
            document.id: document.sha256 for document in report.documents
        },
        "status_counts": {
            status: counts[status] for status in (
                "confirmed_change", "possible_change",
                "contradiction", "missing_information",
            )
        },
        "total_findings": len(report.findings),
        "review_tasks": sum(
            item.requires_human_verification for item in report.checklist
        ),
        "warning_count": len(report.warnings),
        "text_coverage": report.text_coverage,
        "semantic_assistance": report.semantic_assistance,
        "report_sha256": hashlib.sha256(payload).hexdigest(),
        "authority_verified": False,
        "notice": (
            "Uploaded order does not establish authority. Check consequential "
            "claims against the issuing organization's official publications."
        ),
    }


def compare_to_file(
    original_path: Path,
    revised_path: Path,
    output_path: Path,
    *,
    automatic_ocr: bool = False,
    original_ocr_pages: str = "",
    revised_ocr_pages: str = "",
) -> dict:
    """Produce a browser-compatible worker report with no implicit overwrite."""
    _destination(output_path)
    try:
        first_pages = parse_ocr_selection(original_ocr_pages)
        second_pages = parse_ocr_selection(revised_ocr_pages)
    except InvalidDocument as exc:
        raise CliError(str(exc)) from exc

    original = _input_pdf(original_path, "original")
    revised = _input_pdf(revised_path, "revised")
    old_name = safe_filename(original_path.name, fallback="original.pdf")
    new_name = safe_filename(revised_path.name, fallback="revised.pdf")
    try:
        report = run_isolated_comparison(
            original, revised, old_name=old_name, new_name=new_name,
            enable_ocr=automatic_ocr, enable_semantic=False,
            original_ocr_pages=first_pages, revised_ocr_pages=second_pages,
        )
    except InvalidDocument as exc:
        # Do not echo parser-controlled error details into shell logs.
        raise CliError("The local PDF worker rejected an input document.") from exc
    except ProcessingTimedOut as exc:
        raise CliError("PDF processing exceeded the local worker deadline.") from exc
    except ProcessingFailed as exc:
        raise CliError("The isolated PDF worker failed to create a verified report.") from exc

    if report.semantic_assistance != "not_requested":
        # Defense in depth: the deterministic CLI must not silently store an
        # experimental model proposal when a worker is misconfigured.
        raise CliError("The local deterministic comparison returned an unexpected AI proposal.")

    payload = (report.model_dump_json(indent=2) + "\n").encode("utf-8")
    result = _summary(report, payload)
    _publish_report(output_path, payload)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Compare two local PDFs using the isolated NoticeBridge engine, "
            "without network uploads or automatic source authority claims."
        ),
    )
    parser.add_argument("original", type=Path, help="Original local PDF path")
    parser.add_argument("revised", type=Path, help="Revised local PDF path")
    parser.add_argument(
        "--output", required=True, type=Path,
        help="New .json path for the private evidence report (no overwrite)",
    )
    parser.add_argument(
        "--automatic-ocr", action="store_true",
        help="Opt into English/Hindi OCR of pages without native text",
    )
    parser.add_argument(
        "--original-ocr-pages", default="", metavar="PAGES",
        help="Optional original PDF OCR page selection, e.g. 1,3-5",
    )
    parser.add_argument(
        "--revised-ocr-pages", default="", metavar="PAGES",
        help="Optional revised PDF OCR page selection, e.g. 2,4-5",
    )
    parser.add_argument(
        "--summary-json", action="store_true",
        help="Print a quote-free machine-readable result summary",
    )
    args = parser.parse_args(argv)
    try:
        summary = compare_to_file(
            args.original, args.revised, args.output,
            automatic_ocr=args.automatic_ocr,
            original_ocr_pages=args.original_ocr_pages,
            revised_ocr_pages=args.revised_ocr_pages,
        )
    except CliError as exc:
        # Never print a PDF passage, traceback, environment secret or
        # unbounded source text, even if a worker failed unexpectedly.
        message = str(exc)[:ERROR_LIMIT]
        print(f"Comparison failed: {message}", file=sys.stderr)
        return 1

    if args.summary_json:
        print(json.dumps(summary, ensure_ascii=True, sort_keys=True))
    else:
        counts = summary["status_counts"]
        print(
            f"Saved private report: findings: "
            f"{summary['total_findings']} | confirmed: "
            f"{counts['confirmed_change']} | possible: "
            f"{counts['possible_change']} | coverage: {summary['text_coverage']}"
        )
        print("Evidence is not issuer-authenticated. Review the quoted source PDFs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
