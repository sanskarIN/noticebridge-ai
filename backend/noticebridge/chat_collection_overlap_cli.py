"""Verify a collection literal overlap report against its exact native snapshot."""

import argparse
import sys
from pathlib import Path

from .chat_collection_audit import MAX_SNAPSHOT_BYTES, AuditError, encode_audit
from .chat_collection_audit_cli import read_bounded
from .chat_collection_overlap import MAX_OVERLAP_BYTES, audit_overlap
from .compare_cli import CliError, _destination, _publish_report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        _destination(args.output)
        report = read_bounded(args.report, MAX_OVERLAP_BYTES)
        snapshot = read_bounded(args.snapshot, MAX_SNAPSHOT_BYTES)
        result = audit_overlap(report, snapshot)
        _publish_report(args.output, encode_audit(result))
    except (AuditError, CliError, OSError):
        print("Literal overlap audit rejected. Check the local artifacts.", file=sys.stderr)
        return 2
    print("Literal overlap recomputed. Native extraction and PDF bytes remain unchecked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
