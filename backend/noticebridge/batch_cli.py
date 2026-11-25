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
from .provenance import InvalidReportProvenance, verify_report_provenance
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


def prepare_manifest(plan_path: Path, destination: Path) -> dict:
    """Pin explicitly selected pairs without guessing their chronological order.

    Both JSON files must reside in the same directory so that the portable
    source paths retain their original meaning. Do not publish until every
    source has been successfully read, validated and fingerprinted.
    """
    try:
        root = plan_path.resolve(strict=True).parent
        destination_root = destination.parent.resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise BatchError("Unable to resolve the local manifest folder.") from exc
    if root != destination_root:
        raise BatchError("The plan and pinned manifest must share a directory.")
    raw = _decode(_read(plan_path, MAX_MANIFEST_BYTES))
    if (
        raw.keys() != {"version", "cases"}
        or type(raw["version"]) is not int or raw["version"] != 1
        or not isinstance(raw["cases"], list)
        or not 1 <= len(raw["cases"]) <= MAX_CASES
    ):
        raise BatchError("Invalid unpinned batch plan.")
    cases: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for item in raw["cases"]:
        if not isinstance(item, dict) or item.keys() != {"original", "revised"}:
            raise BatchError("Each plan case must specify exactly two PDF paths.")
        old_path = _source_path(root, item["original"])
        new_path = _source_path(root, item["revised"])
        old_hash = _digest(_input_pdf(old_path, "original"))
        new_hash = _digest(_input_pdf(new_path, "revised"))
        pair = (old_hash, new_hash)
        if pair in seen:
            raise BatchError("Duplicate pinned source pair in the batch.")
        seen.add(pair)
        cases.append({
            "original": item["original"],
            "revised": item["revised"],
            "original_sha256": old_hash,
            "revised_sha256": new_hash,
        })
    payload = _index_bytes({"version": 1, "cases": cases})
    if len(payload) > MAX_MANIFEST_BYTES:
        raise BatchError("Pinned manifest exceeds the manifest size limit.")
    _publish_report(destination, payload)
    return {
        "format": "noticebridge-batch-manifest-preparation",
        "case_count": len(cases),
        "manifest_sha256": _digest(payload),
        "authority_verified": False,
    }


def check_manifest(manifest_path: Path) -> dict:
    """Read and check all pinned source bytes without parsing their PDF contents."""
    manifest = load_manifest(manifest_path)
    for case in manifest.cases:
        _sources(case)
    return {
        "format": "noticebridge-batch-source-check",
        "case_count": len(manifest.cases),
        "manifest_sha256": manifest.sha256,
        "source_pins_match": True,
        "authority_verified": False,
    }


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
    return _continue_batch(manifest, output, [], MAX_BATCH_REPORT_BYTES)


def _continue_batch(
    manifest: Manifest, output: Path, rows: list[dict], remaining: int,
) -> dict:
    for number in range(len(rows) + 1, len(manifest.cases) + 1):
        case = manifest.cases[number - 1]
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


def _load_index(output: Path) -> dict:
    if output.is_symlink() or not output.is_dir():
        raise BatchError("Batch output must be a regular directory.")
    index_path = output / INDEX_FILENAME
    if index_path.is_symlink():
        raise BatchError("Batch index must not be a symbolic link.")
    return _decode(_read(index_path, MAX_INDEX_BYTES))


def _inspect_case(
    output: Path, case: Case, number: int, remaining: int, *, replay: bool,
) -> tuple[dict, bytes]:
    """Read a bounded snapshot, validate source pins, optionally replay it."""
    report_path = output / _report_filename(number)
    if report_path.is_symlink():
        raise BatchError("Batch evidence files must not be symbolic links.")
    payload = _read(report_path, min(remaining, MAX_REPORT_BYTES))
    try:
        report = _parse_report(payload)
        # Batch reports are generated by the CLI, not browser exports.
        if payload != (report.model_dump_json(indent=2) + "\n").encode("utf-8"):
            raise BatchError("Batch evidence must match the generated report format.")
        if (
            report.semantic_assistance != "not_requested"
            or report.automatic_ocr is not False
            or any(doc.ocr_page_count or doc.ocr_override_pages for doc in report.documents)
        ):
            raise BatchError("Unexpected OCR or AI evidence in a native-text batch.")
        expected_names = [
            safe_filename(case.original.name, fallback="original.pdf"),
            safe_filename(case.revised.name, fallback="revised.pdf"),
        ]
        if [doc.filename for doc in report.documents] != expected_names:
            raise BatchError("Batch report source names do not match its manifest.")
        original, revised = _sources(case)
        if replay:
            verify_saved_report(report, original, revised, ocr="off")
        else:
            verify_report_provenance(
                report, original=original, revised=revised,
                old_name=expected_names[0], new_name=expected_names[1],
            )
    except (
        ReplayError, CliError, InvalidDocument, InvalidReportProvenance,
        ProcessingFailed, ProcessingTimedOut,
    ) as exc:
        raise BatchError("A batch case failed integrity or replay verification.") from exc
    return _row(number, report, payload), payload


def _assert_same_index(saved: dict, expected: dict) -> None:
    try:
        matches = _same_json(saved, expected)
    except (ValueError, RecursionError) as exc:
        raise BatchError("Invalid batch index.") from exc
    if not matches:
        raise BatchError("Saved batch index does not match replayed evidence.")


def _completed_prefix(manifest: Manifest, saved: dict, *, allow_partial: bool) -> int:
    if not allow_partial and saved.get("complete") is not True:
        raise BatchError("An incomplete batch cannot pass full replay verification.")
    completed = saved.get("completed_count")
    if (
        type(completed) is not int
        or not 0 <= completed <= len(manifest.cases)
        or not isinstance(saved.get("cases"), list)
        or len(saved["cases"]) != completed
        or saved.get("complete") is not (completed == len(manifest.cases))
        or saved.get("manifest_sha256") != manifest.sha256
    ):
        raise BatchError("Saved batch index does not match its completion or manifest claims.")
    return completed


def _inspect_batch(
    manifest: Manifest, output: Path, saved: dict, *,
    replay: bool, allow_partial: bool = False,
) -> dict:
    completed = _completed_prefix(manifest, saved, allow_partial=allow_partial)
    rows: list[dict] = []
    remaining = MAX_BATCH_REPORT_BYTES
    for number, case in enumerate(manifest.cases[:completed], 1):
        row, payload = _inspect_case(output, case, number, remaining, replay=replay)
        remaining -= len(payload)
        rows.append(row)
    expected = _index(manifest, rows)
    _assert_same_index(saved, expected)
    return expected


def audit_batch(manifest_path: Path, output: Path) -> dict:
    """Check hashes, structure and provenance, without independently replaying PDFs.

    A self-consistent forged quotation may pass this structural check. The
    result deliberately distinguishes it from full engine replay.
    """
    manifest = load_manifest(manifest_path)
    expected = _inspect_batch(manifest, output, _load_index(output), replay=False)
    return {
        "format": "noticebridge-batch-structural-audit",
        "manifest_sha256": manifest.sha256,
        "case_count": expected["case_count"],
        "completed_count": expected["completed_count"],
        "complete": True,
        "structural_checks_passed": True,
        "engine_replayed": False,
        "authority_verified": False,
        "status_counts": expected["status_counts"],
    }


def verify_batch(manifest_path: Path, output: Path) -> dict:
    manifest = load_manifest(manifest_path)
    saved = _load_index(output)
    # Check all hashes and index claims before dispatching even one parser.
    _inspect_batch(manifest, output, saved, replay=False)
    # Recheck the exact bytes on the second pass; do not trust a stale audit.
    return _inspect_batch(manifest, output, saved, replay=True)


def audit_prefix(manifest_path: Path, output: Path) -> dict:
    """Validate a recorded completed prefix without implying batch completeness."""
    manifest = load_manifest(manifest_path)
    result = _inspect_batch(
        manifest, output, _load_index(output), replay=False, allow_partial=True,
    )
    return {
        "format": "noticebridge-batch-prefix-audit",
        "manifest_sha256": manifest.sha256,
        "case_count": result["case_count"],
        "completed_count": result["completed_count"],
        "complete": result["complete"],
        "structural_checks_passed": True,
        "engine_replayed": False,
        "authority_verified": False,
        "status_counts": result["status_counts"],
    }


def recover_batch(manifest_path: Path, previous: Path, output: Path) -> dict:
    """Recover an indexed partial batch into a different, new directory.

    Do not trust old evidence just because a previous command wrote it.
    Validate all existing prefix claims before opening the output directory,
    then independently replay each copied report using its exact bytes.
    A new result remains incomplete if any replay or subsequent comparison
    fails. The previous directory is never written to or deleted.
    """
    manifest = load_manifest(manifest_path)
    saved = _load_index(previous)
    if saved.get("complete") is True:
        raise BatchError("Recovery requires an incomplete batch index.")
    prefix = _inspect_batch(manifest, previous, saved, replay=False, allow_partial=True)
    # Check all sources, including cases not previously processed, before
    # creating a recovery directory. Check again at every worker invocation.
    for case in manifest.cases:
        _sources(case)
    _new_directory(output)
    remaining = MAX_BATCH_REPORT_BYTES
    rows: list[dict] = []
    for number, case in enumerate(manifest.cases[:prefix["completed_count"]], 1):
        try:
            row, payload = _inspect_case(previous, case, number, remaining, replay=True)
            _assert_same_index(prefix["cases"][number - 1], row)
            _publish_report(output / _report_filename(number), payload)
            rows.append(row)
            remaining -= len(payload)
        except (BatchError, CliError, OSError):
            index = _index(manifest, rows)
            _publish_report(output / INDEX_FILENAME, _index_bytes(index))
            return index
    return _continue_batch(manifest, output, rows, remaining)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("run", "verify", "audit", "prepare", "check", "audit-prefix", "recover"):
        sub = commands.add_parser(command)
        sub.add_argument("manifest", type=Path)
        if command != "check":
            sub.add_argument("--output", type=Path, required=True)
        if command == "recover":
            sub.add_argument("--previous", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "prepare":
            print(json.dumps(prepare_manifest(args.manifest, args.output), sort_keys=True))
            return 0
        if args.command == "check":
            print(json.dumps(check_manifest(args.manifest), sort_keys=True))
            return 0
        if args.command == "audit":
            print(json.dumps(audit_batch(args.manifest, args.output), sort_keys=True))
            return 0
        if args.command == "audit-prefix":
            result = audit_prefix(args.manifest, args.output)
            print(json.dumps(result, sort_keys=True))
            return 0 if result["complete"] else 1
        if args.command == "recover":
            index = recover_batch(args.manifest, args.previous, args.output)
        elif args.command == "run":
            index = run_batch(args.manifest, args.output)
        else:
            index = verify_batch(args.manifest, args.output)
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
    } | {"engine_replayed": args.command == "verify"}, sort_keys=True))
    return 0 if index["complete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
