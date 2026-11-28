"""Audit a focused question brief or comparison against exact recorded evidence."""

import argparse
import sys
from pathlib import Path

from .chat_collection_audit import MAX_PACKET_BYTES, MAX_SNAPSHOT_BYTES, AuditError, encode_audit
from .chat_collection_audit_cli import read_bounded
from .chat_collection_question_audit import MAX_BRIEF_BYTES, audit_question_artifact
from .compare_cli import CliError, _destination, _publish_report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("packet", type=Path)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        _destination(args.output)
        report = read_bounded(args.report, MAX_BRIEF_BYTES)
        packet = read_bounded(args.packet, MAX_PACKET_BYTES)
        snapshot = read_bounded(args.snapshot, MAX_SNAPSHOT_BYTES)
        checked = audit_question_artifact(report, packet, snapshot)
        _publish_report(args.output, encode_audit(checked))
    except (AuditError, CliError, OSError, KeyError):
        print("Question artifact audit rejected. Check exact local artifacts.", file=sys.stderr)
        return 2
    print("Recorded question artifact recomputed. Ranking and extraction not replayed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
