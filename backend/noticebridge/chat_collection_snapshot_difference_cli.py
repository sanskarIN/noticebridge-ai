"""Verify a native collection snapshot difference report independently."""

import argparse
import sys
from pathlib import Path

from .chat_collection_audit import MAX_SNAPSHOT_BYTES, AuditError, encode_audit
from .chat_collection_audit_cli import read_bounded
from .chat_collection_snapshot_difference import MAX_DIFFERENCE_BYTES, audit_difference
from .compare_cli import CliError, _destination, _publish_report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("left", type=Path)
    parser.add_argument("right", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--require-exact", action="store_true")
    args = parser.parse_args(argv)
    try:
        _destination(args.output)
        report = read_bounded(args.report, MAX_DIFFERENCE_BYTES)
        left = read_bounded(args.left, MAX_SNAPSHOT_BYTES)
        right = read_bounded(args.right, MAX_SNAPSHOT_BYTES)
        result = audit_difference(report, left, right)
        _publish_report(args.output, encode_audit(result))
    except (AuditError, CliError, OSError):
        print("Snapshot difference audit rejected. Check the local artifacts.", file=sys.stderr)
        return 2
    print("Snapshot difference recomputed; PDF bytes and native extraction remain unchecked.")
    return 3 if args.require_exact and not result["exact_snapshot_match"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
