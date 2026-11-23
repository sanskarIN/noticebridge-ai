"""Verify a saved evidence report by replaying its PDF comparison locally."""

import argparse
import json
from pathlib import Path
from typing import Literal

from pydantic import ValidationError

from .extract import MAX_UPLOAD_BYTES, InvalidDocument, validate_ocr_pages
from .isolation import (
    MAX_RESULT_BYTES,
    ProcessingFailed,
    ProcessingTimedOut,
    run_isolated_comparison,
)
from .models import ComparisonReport
from .provenance import InvalidReportProvenance, verify_report_provenance

MAX_SAVED_REPORT_BYTES = 2 * MAX_RESULT_BYTES  # Browser JSON includes indentation.
OcrMode = Literal["off", "selected", "automatic"]


class ReplayError(ValueError):
    """A saved report cannot be verified under the selected replay settings."""


def _read_bounded(path: Path, limit: int, label: str) -> bytes:
    try:
        with path.open("rb") as source:
            data = source.read(limit + 1)
    except OSError as exc:
        raise ReplayError(f"Unable to read the {label}.") from exc
    if not 0 < len(data) <= limit:
        raise ReplayError(f"The {label} must be nonempty and at most {limit // (1024 * 1024)} MiB.")
    return data


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    fields: dict[str, object] = {}
    for name, value in pairs:
        if name in fields:
            raise ReplayError("The saved report contains a duplicate JSON field.")
        fields[name] = value
    return fields


def _reject_nonfinite(_: str) -> None:
    raise ReplayError("The saved report contains a non-finite JSON number.")


def _load_report(path: Path) -> ComparisonReport:
    data = _read_bounded(path, MAX_SAVED_REPORT_BYTES, "saved report")
    try:
        raw = json.loads(data, object_pairs_hook=_unique_object, parse_constant=_reject_nonfinite)
    except ReplayError:
        raise
    except (ValueError, RecursionError) as exc:
        raise ReplayError("The saved report is not valid JSON.") from exc
    try:
        return ComparisonReport.model_validate(raw)
    except ValidationError as exc:
        # Pydantic errors can echo source paragraphs in a malformed report.
        raise ReplayError("The saved report does not contain a valid evidence report.") from exc


def verify_saved_report(
    report: ComparisonReport, original: bytes, revised: bytes, *, ocr: OcrMode | None = None,
) -> None:
    """Check fingerprints and reproduce the engine fields from the supplied bytes."""
    if [document.id for document in report.documents] != ["original", "revised"]:
        raise ReplayError("The report must list the original PDF first and the revised PDF second.")
    if report.semantic_assistance != "not_requested":
        raise ReplayError("Replay requires a comparison with experimental AI suggestions disabled.")

    old, new = report.documents
    old_pages = validate_ocr_pages(old.ocr_override_pages)
    new_pages = validate_ocr_pages(new.ocr_override_pages)
    if ocr is None:
        if report.automatic_ocr is True:
            ocr = "automatic"
        elif report.automatic_ocr is False and (old_pages or new_pages):
            ocr = "selected"
        else:
            ocr = "off"
    if ocr == "off" and (old_pages or new_pages or old.ocr_page_count or new.ocr_page_count):
        raise ReplayError("This report used OCR. Select --ocr selected or --ocr automatic.")
    options = {
        "old_name": old.filename,
        "new_name": new.filename,
        "original_ocr_pages": old_pages,
        "revised_ocr_pages": new_pages,
    }
    automatic = ocr == "automatic"
    # Validate the source hashes and read the saved document roles before
    # sending any bytes to a parser. Names from the report are display metadata.
    verify_report_provenance(
        report, original=original, revised=revised, ocr_requested=automatic, **options,
    )
    replayed = run_isolated_comparison(original, revised, enable_ocr=automatic, **options)
    if report.automatic_ocr is None:
        replayed = replayed.model_copy(update={"automatic_ocr": None})
    if replayed != report:
        raise ReplayError(
            "The saved evidence differs from the replay. "
            "Check the engine version and OCR settings used to export it."
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path, help="NoticeBridge evidence JSON")
    parser.add_argument("original", type=Path, help="Original source PDF")
    parser.add_argument("revised", type=Path, help="Revised source PDF")
    parser.add_argument(
        "--ocr", choices=("off", "selected", "automatic"),
        help="Set the OCR mode for an older export. New exports record it automatically.",
    )
    args = parser.parse_args(argv)
    try:
        report = _load_report(args.report)
        original = _read_bounded(args.original, MAX_UPLOAD_BYTES, "original PDF")
        revised = _read_bounded(args.revised, MAX_UPLOAD_BYTES, "revised PDF")
        verify_saved_report(report, original, revised, ocr=args.ocr)
    except (ReplayError, InvalidReportProvenance, InvalidDocument) as exc:
        parser.exit(1, f"Verification failed: {exc}\n")
    except (ProcessingFailed, ProcessingTimedOut):
        parser.exit(1, "Verification failed: The local PDF worker could not finish the replay.\n")
    print(f"Verified both SHA-256 fingerprints and reproduced {len(report.findings)} finding(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
