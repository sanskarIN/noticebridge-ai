"""Audit recorded collection retrieval metrics independently of the browser ranker."""

import argparse
import sys
from pathlib import Path

from .chat_collection_audit import MAX_SNAPSHOT_BYTES, AuditError, encode_audit
from .chat_collection_audit_cli import read_bounded
from .chat_collection_evaluation_audit import MAX_EVALUATION_BYTES, audit_evaluation
from .compare_cli import CliError, _destination, _publish_report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("labels", type=Path)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        _destination(args.output)
        report = read_bounded(args.report, MAX_EVALUATION_BYTES)
        labels = read_bounded(args.labels, MAX_EVALUATION_BYTES)
        snapshot = read_bounded(args.snapshot, MAX_SNAPSHOT_BYTES)
        result = audit_evaluation(report, labels, snapshot)
        _publish_report(args.output, encode_audit(result))
    except (AuditError, CliError, OSError):
        print("Collection evaluation audit rejected. Check the local artifacts.", file=sys.stderr)
        return 2
    print("Recorded metric arithmetic checked; retrieval and native extraction not replayed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
