"""Audit and reconcile local human-review ledgers without changing engine evidence."""

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

from .batch_cli import (
    INDEX_FILENAME,
    MAX_INDEX_BYTES,
    BatchError,
    _decode,
    _digest,
    _hash_field,
    _index_bytes,
    _inspect_batch,
    _read,
    load_manifest,
)
from .compare_cli import CliError, _publish_report

MAX_LEDGER_BYTES = 16 * 1024
FORMAT = "noticebridge-batch-review-ledger"
RESOLUTION_FORMAT = "noticebridge-batch-review-resolution"
POLICY = "Human review markers only; engine replay and issuer authority are not certified."
STATES = ("unreviewed", "in_progress", "follow_up", "reviewed")
MARKED = frozenset(STATES[1:])
LEDGER_KEYS = {
    "format", "version", "index_sha256", "manifest_sha256",
    "case_count", "completed_count", "authority_verified", "engine_replayed",
    "policy", "reviews",
}


class ReviewError(ValueError):
    """Fixed local error message; no user text or filesystem paths."""


@dataclass(frozen=True)
class BatchBinding:
    index_sha256: str
    manifest_sha256: str
    case_count: int
    report_hashes: tuple[str, ...]

    @property
    def completed_count(self) -> int:
        return len(self.report_hashes)


@dataclass(frozen=True)
class ReviewLedger:
    sha256: str
    # Only explicitly marked cases are stored; absence is not a verdict.
    entries: tuple[tuple[int, str], ...]


def load_binding(manifest_path: Path, directory: Path) -> BatchBinding:
    """Validate the exact index snapshot and every completed report structurally."""
    if directory.is_symlink() or not directory.is_dir():
        raise ReviewError("Expected a regular batch directory.")
    path = directory / INDEX_FILENAME
    if path.is_symlink():
        raise ReviewError("Batch index must not be a symbolic link.")
    payload = _read(path, MAX_INDEX_BYTES)
    manifest = load_manifest(manifest_path)
    index = _inspect_batch(
        manifest, directory, _decode(payload), replay=False, allow_partial=True,
    )
    return BatchBinding(
        index_sha256=_digest(payload), manifest_sha256=manifest.sha256,
        case_count=len(manifest.cases),
        report_hashes=tuple(row["report_sha256"] for row in index["cases"]),
    )


def _case_number(value: object, binding: BatchBinding) -> int:
    if type(value) is not int or not 1 <= value <= binding.completed_count:
        raise ReviewError("Review case must identify a completed batch case.")
    return value


def _state(value: object, *, allow_unreviewed: bool = False) -> str:
    allowed = STATES if allow_unreviewed else MARKED
    if not isinstance(value, str) or value not in allowed:
        raise ReviewError("Invalid human review marker.")
    return value


def _version(raw: dict, format_name: str) -> None:
    if raw.get("format") != format_name or type(raw.get("version")) is not int:
        raise ReviewError("Unsupported review file format.")
    if raw["version"] != 1:
        raise ReviewError("Unsupported review file version.")


def parse_ledger(payload: bytes, binding: BatchBinding) -> ReviewLedger:
    if not payload or len(payload) > MAX_LEDGER_BYTES:
        raise ReviewError("Review ledger is empty or exceeds 16 KiB.")
    raw = _decode(payload)
    if raw.keys() != LEDGER_KEYS:
        raise ReviewError("Invalid review ledger fields.")
    _version(raw, FORMAT)
    if (
        raw["authority_verified"] is not False
        or raw["engine_replayed"] is not False
        or raw["policy"] != POLICY
    ):
        raise ReviewError("Review ledger cannot assert verified evidence or authority.")
    if (
        _hash_field(raw["index_sha256"]) != binding.index_sha256
        or _hash_field(raw["manifest_sha256"]) != binding.manifest_sha256
        or type(raw["case_count"]) is not int or raw["case_count"] != binding.case_count
        or type(raw["completed_count"]) is not int
        or raw["completed_count"] != binding.completed_count
    ):
        raise ReviewError("Review ledger does not match the exact batch index.")
    entries = raw["reviews"]
    if not isinstance(entries, list) or len(entries) > binding.completed_count:
        raise ReviewError("Invalid review entry list.")
    result: dict[int, str] = {}
    for entry in entries:
        if not isinstance(entry, dict) or entry.keys() != {"case", "report_sha256", "state"}:
            raise ReviewError("Invalid review entry fields.")
        number = _case_number(entry["case"], binding)
        if number in result:
            raise ReviewError("Repeated review case.")
        if _hash_field(entry["report_sha256"]) != binding.report_hashes[number - 1]:
            raise ReviewError("Review report fingerprint differs from the batch index.")
        result[number] = _state(entry["state"])
    return ReviewLedger(_digest(payload), tuple(sorted(result.items())))


def read_ledger(path: Path, binding: BatchBinding) -> ReviewLedger:
    if path.is_symlink():
        raise ReviewError("Review ledger must not be a symbolic link.")
    return parse_ledger(_read(path, MAX_LEDGER_BYTES), binding)


def ledger_payload(binding: BatchBinding, entries: dict[int, str]) -> bytes:
    rows = []
    for number, state in sorted(entries.items()):
        number = _case_number(number, binding)
        rows.append({
            "case": number, "report_sha256": binding.report_hashes[number - 1],
            "state": _state(state),
        })
    data = _index_bytes({
        "format": FORMAT, "version": 1,
        "index_sha256": binding.index_sha256, "manifest_sha256": binding.manifest_sha256,
        "case_count": binding.case_count, "completed_count": binding.completed_count,
        "authority_verified": False, "engine_replayed": False,
        "policy": POLICY, "reviews": rows,
    })
    if len(data) > MAX_LEDGER_BYTES:
        raise ReviewError("Generated ledger exceeds 16 KiB.")
    return data


def review_summary(binding: BatchBinding, ledger: ReviewLedger) -> dict:
    counts = dict.fromkeys(STATES, 0)
    entries = dict(ledger.entries)
    for number in range(1, binding.completed_count + 1):
        counts[entries.get(number, "unreviewed")] += 1
    return {
        "format": "noticebridge-batch-human-review-summary",
        "index_sha256": binding.index_sha256,
        "ledger_sha256": ledger.sha256,
        "case_count": binding.case_count,
        "completed_count": binding.completed_count,
        "batch_complete": binding.case_count == binding.completed_count,
        "human_review_counts": counts,
        "authority_verified": False,
        "engine_replayed": False,
    }


def compare_ledgers(
    binding: BatchBinding, first: ReviewLedger, second: ReviewLedger,
) -> dict:
    """Distinguish missing markers from genuine disagreements."""
    a, b = dict(first.entries), dict(second.entries)
    conflicts = []
    agreed, single, unmarked = [], [], []
    for number in range(1, binding.completed_count + 1):
        left, right = a.get(number), b.get(number)
        if left is None and right is None:
            unmarked.append(number)
        elif left is None or right is None:
            single.append(number)
        elif left == right:
            agreed.append(number)
        else:
            conflicts.append({"case": number, "first": left, "second": right})
    return {
        "format": "noticebridge-batch-review-comparison",
        "index_sha256": binding.index_sha256,
        "first_ledger_sha256": first.sha256,
        "second_ledger_sha256": second.sha256,
        "agreed_cases": agreed,
        "single_marker_cases": single,
        "unmarked_cases": unmarked,
        "conflicts": conflicts,
        "authority_verified": False,
        "engine_replayed": False,
    }


def resolution_template(comparison: dict) -> dict:
    """Leave each conflicting case unresolved until a human selects a marker."""
    return {
        "format": RESOLUTION_FORMAT,
        "version": 1,
        "index_sha256": comparison["index_sha256"],
        "first_ledger_sha256": comparison["first_ledger_sha256"],
        "second_ledger_sha256": comparison["second_ledger_sha256"],
        "resolutions": [{"case": item["case"], "state": None}
                        for item in comparison["conflicts"]],
    }


def parse_resolutions(payload: bytes, binding: BatchBinding, comparison: dict) -> dict[int, str]:
    if not payload or len(payload) > MAX_LEDGER_BYTES:
        raise ReviewError("Resolution file is empty or exceeds 16 KiB.")
    raw = _decode(payload)
    template = resolution_template(comparison)
    if raw.keys() != template.keys():
        raise ReviewError("Invalid review resolution fields.")
    _version(raw, RESOLUTION_FORMAT)
    for key in ("index_sha256", "first_ledger_sha256", "second_ledger_sha256"):
        if _hash_field(raw[key]) != template[key]:
            raise ReviewError("Resolution does not match the exact input ledgers and index.")
    expected = {item["case"] for item in comparison["conflicts"]}
    values = raw["resolutions"]
    if not isinstance(values, list) or len(values) != len(expected):
        raise ReviewError("Every conflicting case needs one explicit resolution.")
    result = {}
    for item in values:
        if not isinstance(item, dict) or item.keys() != {"case", "state"}:
            raise ReviewError("Invalid review resolution entry.")
        number = _case_number(item["case"], binding)
        if number not in expected or number in result:
            raise ReviewError("Resolution contains a repeated or non-conflicting case.")
        result[number] = _state(item["state"], allow_unreviewed=True)
    return result


def reconcile_ledgers(
    binding: BatchBinding, first: ReviewLedger, second: ReviewLedger,
    *, resolution: bytes | None = None,
) -> bytes:
    comparison = compare_ledgers(binding, first, second)
    conflicts = comparison["conflicts"]
    if conflicts and resolution is None:
        raise ReviewError("Conflicting review markers require an explicit resolution file.")
    resolutions = (
        parse_resolutions(resolution, binding, comparison) if resolution is not None else {}
    )
    a, b = dict(first.entries), dict(second.entries)
    result = {}
    for number in range(1, binding.completed_count + 1):
        if number in resolutions:
            value = resolutions[number]
        else:
            value = a.get(number) or b.get(number) or "unreviewed"
        if value != "unreviewed":
            result[number] = value
    return ledger_payload(binding, result)


def _resolution_bytes(path: Path) -> bytes:
    if path.is_symlink():
        raise ReviewError("Resolution file must not be a symbolic link.")
    return _read(path, MAX_LEDGER_BYTES)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("inspect", "compare", "merge"):
        sub = commands.add_parser(command)
        sub.add_argument("manifest", type=Path)
        sub.add_argument("--batch", type=Path, required=True)
        sub.add_argument("--first", type=Path, required=True)
        if command != "inspect":
            sub.add_argument("--second", type=Path, required=True)
        if command == "compare":
            sub.add_argument("--template", type=Path)
        if command == "merge":
            sub.add_argument("--resolution", type=Path)
            sub.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        binding = load_binding(args.manifest, args.batch)
        first = read_ledger(args.first, binding)
        if args.command == "inspect":
            result = review_summary(binding, first)
        else:
            second = read_ledger(args.second, binding)
            comparison = compare_ledgers(binding, first, second)
            if args.command == "compare":
                if args.template:
                    _publish_report(args.template, _index_bytes(resolution_template(comparison)))
                result = comparison
            else:
                resolution = _resolution_bytes(args.resolution) if args.resolution else None
                payload = reconcile_ledgers(binding, first, second, resolution=resolution)
                _publish_report(args.output, payload)
                result = review_summary(binding, parse_ledger(payload, binding))
    except (BatchError, CliError, ReviewError, OSError, ValueError, RecursionError):
        print("Review operation failed: check the batch, ledgers and resolution.", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    # Comparing ledgers is an inspection operation. A conflict is deliberately
    # represented in the result, not treated as an operational failure.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
