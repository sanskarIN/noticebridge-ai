"""Audit recorded collection citation usage against its review packet and snapshot."""

import argparse
import sys
from pathlib import Path

from .chat_collection_audit import MAX_PACKET_BYTES, MAX_SNAPSHOT_BYTES, AuditError, encode_audit
from .chat_collection_audit_cli import read_bounded
from .chat_collection_usage_audit import MAX_USAGE_BYTES, audit_usage
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
        report = read_bounded(args.report, MAX_USAGE_BYTES)
        packet = read_bounded(args.packet, MAX_PACKET_BYTES)
        snapshot = read_bounded(args.snapshot, MAX_SNAPSHOT_BYTES)
        result = audit_usage(report, packet, snapshot)
        _publish_report(args.output, encode_audit(result))
    except (AuditError, CliError, OSError):
        print("Citation usage audit rejected. Check exact local artifacts.", file=sys.stderr)
        return 2
    print("Recorded citation usage recomputed. Native extraction and retrieval not replayed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
