"""Bounded, pinned, local batch comparison and evidence replay.

A batch is a convenience workflow, not an accuracy benchmark or an authority
certification. Only native-text deterministic comparisons are supported here.
"""

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath

from .api import safe_filename
from .compare_cli import CliError, _input_pdf, _publish_report, _summary
from .extract import InvalidDocument
from .isolation import ProcessingFailed, ProcessingTimedOut, run_isolated_comparison
from .provenance import InvalidReportProvenance
from .verify_report import ReplayError, _parse_report, verify_saved_report

MAX_MANIFEST_BYTES = 64 * 1024
MAX_INDEX_BYTES = 128 * 1024
MAX_CASES = 16
MAX_BATCH_REPORT_BYTES = 128 * 1024 * 1024
MAX_REPORT_BYTES = 64 * 1024 * 1024
SHA256 = re.compile(r"[a-f0-9]{64}")
CASE_KEYS = {"original", "revised", "original_sha256", "revised_sha256"}
STATUS = ("confirmed_change", "possible_change", "contradiction", "missing_information")
INDEX_FILENAME = "index.json"


class BatchError(ValueError):
    """Fixed, quote-free error suitable for terminal output."""


@dataclass(frozen=True)
class Case:
    original: Path
    revised: Path
    original_sha256: str
    revised_sha256: str


@dataclass(frozen=True)
class Manifest:
    cases: tuple[Case, ...]
    sha256: str


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _read(path: Path, limit: int) -> bytes:
    try:
        if not path.is_file():
            raise BatchError("Expected a regular local file.")
        with path.open("rb") as stream:
            data = stream.read(limit + 1)
    except OSError as exc:
        raise BatchError("Unable to read a local batch file.") from exc
    if not data or len(data) > limit:
        raise BatchError("A local batch file is empty or exceeds its size limit.")
    return data


def _unique(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise BatchError("Duplicate JSON member in a batch file.")
        result[key] = value
    return result


def _invalid_constant(_: str):
    raise BatchError("Non-finite JSON value in a batch file.")


def _decode(data: bytes) -> dict:
    try:
        value = json.loads(
            data.decode("utf-8"),
            object_pairs_hook=_unique,
            parse_constant=_invalid_constant,
        )
    except BatchError:
        raise
    except (ValueError, RecursionError) as exc:
        raise BatchError("Invalid batch JSON.") from exc
    if not isinstance(value, dict):
        raise BatchError("Expected a JSON object in a batch file.")
    return value


def _source_path(root: Path, raw: object) -> Path:
    # Use portable relative paths. Reject Windows drive-relative paths even
    # when validation runs on Linux, and do not accept parent traversal.
    if (
        not isinstance(raw, str) or not raw or len(raw) > 240
        or any(ord(char) < 32 for char in raw)
        or "\\" in raw or ":" in raw
    ):
        raise BatchError("Invalid relative source path.")
    posix = PurePosixPath(raw)
    windows = PureWindowsPath(raw)
    if (
        posix.is_absolute() or windows.drive
        or any(part in ("", ".", "..") for part in raw.split("/"))
        or posix.suffix.casefold() != ".pdf"
    ):
        raise BatchError("Invalid relative source path.")
    try:
        path = (root / raw).resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise BatchError("Unable to resolve a local source PDF.") from exc
    if not path.is_relative_to(root) or not path.is_file():
        raise BatchError("Source PDF must be a regular file inside the manifest folder.")
    return path


def _hash_field(value: object) -> str:
    if not isinstance(value, str) or not SHA256.fullmatch(value):
        raise BatchError("Every source must have a lowercase SHA-256 fingerprint.")
    return value


def load_manifest(path: Path) -> Manifest:
    data = _read(path, MAX_MANIFEST_BYTES)
    raw = _decode(data)
    if raw.keys() != {"version", "cases"} or type(raw["version"]) is not int:
        raise BatchError("Invalid batch manifest schema.")
    if raw["version"] != 1:
        raise BatchError("Unsupported batch manifest version.")
    cases = raw["cases"]
    if not isinstance(cases, list) or not 1 <= len(cases) <= MAX_CASES:
        raise BatchError("A batch must contain between 1 and 16 notice pairs.")
    root = path.resolve().parent
    result = []
    seen = set()
    for item in cases:
        if not isinstance(item, dict) or item.keys() != CASE_KEYS:
            raise BatchError("Invalid batch case schema.")
        old_hash = _hash_field(item["original_sha256"])
        new_hash = _hash_field(item["revised_sha256"])
        pair = (old_hash, new_hash)
        if pair in seen:
            raise BatchError("Duplicate pinned source pair in the batch.")
        seen.add(pair)
        result.append(Case(
            _source_path(root, item["original"]),
            _source_path(root, item["revised"]),
            old_hash, new_hash,
        ))
    return Manifest(tuple(result), _digest(data))


def _sources(case: Case) -> tuple[bytes, bytes]:
    # Fingerprint the very bytes passed to the worker, not an earlier read.
    original = _input_pdf(case.original, "original")
    revised = _input_pdf(case.revised, "revised")
    if (_digest(original), _digest(revised)) != (
        case.original_sha256, case.revised_sha256,
    ):
        raise BatchError("Source bytes differ from the pinned manifest fingerprints.")
    return original, revised


def _report_filename(number: int) -> str:
    return f"case-{number:03d}.json"


def _index(manifest: Manifest, rows: list[dict]) -> dict:
    counts = {status: 0 for status in STATUS}
    for row in rows:
        for status in STATUS:
            counts[status] += row["status_counts"][status]
    return {
        "format": "noticebridge-batch-index",
        "version": 1,
        "manifest_sha256": manifest.sha256,
        "case_count": len(manifest.cases),
        "completed_count": len(rows),
        "complete": len(rows) == len(manifest.cases),
        "authority_verified": False,
        "status_counts": counts,
        "cases": rows,
    }


def _row(number: int, report, payload: bytes) -> dict:
    return {
        "case": number,
        "report": _report_filename(number),
        **_summary(report, payload),
    }


def _index_bytes(index: dict) -> bytes:
    return (json.dumps(index, sort_keys=True, indent=2) + "\n").encode("utf-8")


def _new_directory(path: Path) -> None:
    try:
        path.mkdir(mode=0o700, parents=False, exist_ok=False)
    except OSError as exc:
        raise BatchError("Batch output must be a new directory in an existing folder.") from exc


def run_batch(manifest_path: Path, output: Path) -> dict:
    manifest = load_manifest(manifest_path)
    _new_directory(output)
    rows: list[dict] = []
    remaining = MAX_BATCH_REPORT_BYTES
    for number, case in enumerate(manifest.cases, 1):
        try:
            original, revised = _sources(case)
            report = run_isolated_comparison(
                original, revised,
                old_name=safe_filename(case.original.name, fallback="original.pdf"),
                new_name=safe_filename(case.revised.name, fallback="revised.pdf"),
                enable_ocr=False, enable_semantic=False,
            )
            if (
                report.semantic_assistance != "not_requested"
                or report.automatic_ocr is not False
                or any(doc.ocr_page_count or doc.ocr_override_pages for doc in report.documents)
            ):
                raise BatchError("Worker returned unexpected OCR or AI evidence.")
            payload = (report.model_dump_json(indent=2) + "\n").encode("utf-8")
            if len(payload) > min(remaining, MAX_REPORT_BYTES):
                raise BatchError("Batch evidence size budget exceeded.")
            row = _row(number, report, payload)
            _publish_report(output / _report_filename(number), payload)
            remaining -= len(payload)
            rows.append(row)
        except (BatchError, CliError, InvalidDocument, ProcessingFailed, ProcessingTimedOut):
            # Preserve successfully published reports; do not imply completeness.
            # Never echo a parser exception or path to the terminal.
            break
    index = _index(manifest, rows)
    _publish_report(output / INDEX_FILENAME, _index_bytes(index))
    return index


def _same_json(a: object, b: object) -> bool:
    # Canonical serialization distinguishes booleans from integers, unlike
    # ordinary Python dictionary equality.
    return json.dumps(a, sort_keys=True, allow_nan=False) == json.dumps(
        b, sort_keys=True, allow_nan=False,
    )


def verify_batch(manifest_path: Path, output: Path) -> dict:
    manifest = load_manifest(manifest_path)
    saved = _decode(_read(output / INDEX_FILENAME, MAX_INDEX_BYTES))
    if saved.get("complete") is not True:
        raise BatchError("An incomplete batch cannot pass full replay verification.")
    rows: list[dict] = []
    remaining = MAX_BATCH_REPORT_BYTES
    for number, case in enumerate(manifest.cases, 1):
        # Use generated names, never a path supplied by the saved index.
        report_path = output / _report_filename(number)
        if report_path.is_symlink():
            raise BatchError("Batch evidence files must not be symbolic links.")
        payload = _read(report_path, min(remaining, MAX_REPORT_BYTES))
        remaining -= len(payload)
        try:
            report = _parse_report(payload)
            if (
                report.semantic_assistance != "not_requested"
                or report.automatic_ocr is not False
                or any(doc.ocr_page_count or doc.ocr_override_pages for doc in report.documents)
            ):
                raise BatchError("Unexpected OCR or AI evidence in a native-text batch.")
            # Bind the report's display names to the manifest as well as bytes.
            expected_names = [
                safe_filename(case.original.name, fallback="original.pdf"),
                safe_filename(case.revised.name, fallback="revised.pdf"),
            ]
            if [doc.filename for doc in report.documents] != expected_names:
                raise BatchError("Batch report source names do not match its manifest.")
            original, revised = _sources(case)
            verify_saved_report(report, original, revised, ocr="off")
        except (
            ReplayError, CliError, InvalidDocument, InvalidReportProvenance,
            ProcessingFailed, ProcessingTimedOut,
        ) as exc:
            raise BatchError("A batch case could not be independently replayed.") from exc
        rows.append(_row(number, report, payload))
    expected = _index(manifest, rows)
    try:
        matches = _same_json(saved, expected)
    except (ValueError, RecursionError) as exc:
        raise BatchError("Invalid batch index.") from exc
    if not matches:
        raise BatchError("Saved batch index does not match replayed evidence.")
    return expected


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("run", "verify"):
        sub = commands.add_parser(command)
        sub.add_argument("manifest", type=Path)
        sub.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        index = (
            run_batch(args.manifest, args.output) if args.command == "run"
            else verify_batch(args.manifest, args.output)
        )
    except (BatchError, CliError, OSError, ValueError, RecursionError):
        print("Batch failed: check the manifest, source pins and local output.", file=sys.stderr)
        return 1
    # Only aggregate counters and manifest hash are printed. Neither filenames
    # nor arbitrary manifest fields nor PDF quotations appear in terminal logs.
    print(json.dumps({
        key: index[key] for key in (
            "manifest_sha256", "case_count", "completed_count", "complete",
            "authority_verified", "status_counts",
        )
    }, sort_keys=True))
    return 0 if index["complete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
