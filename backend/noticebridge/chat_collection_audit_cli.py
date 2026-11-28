"""Check private collection packet structure offline; never contact an AI model."""

import argparse
import sys
from pathlib import Path

from .chat_collection_audit import (
    MAX_PACKET_BYTES,
    MAX_SNAPSHOT_BYTES,
    AuditError,
    audit_packet,
    encode_audit,
)
from .compare_cli import CliError, _destination, _publish_report


def read_bounded(path: Path, maximum: int) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise AuditError("Select regular local artifact files.")
    with path.open("rb") as stream:
        data = stream.read(maximum + 1)
    if not data or len(data) > maximum:
        raise AuditError("Artifact exceeds its size budget.")
    return data


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("packet", type=Path)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--pdf", type=Path, action="append",
                        help="Optional independently selected PDF; repeat for each source.")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        _destination(args.output)
        packet = read_bounded(args.packet, MAX_PACKET_BYTES)
        snapshot = read_bounded(args.snapshot, MAX_SNAPSHOT_BYTES)
        result = audit_packet(packet, snapshot, args.pdf)
        _publish_report(args.output, encode_audit(result))
    except (AuditError, CliError, OSError):
        print("Collection structural audit failed. Check the local files.", file=sys.stderr)
        return 2
    if result["pdf_byte_set_matches"] is False:
        print("Structural audit written; selected PDF bytes do not match the snapshot.")
        return 3
    print("Structural audit written. Native extraction and retrieval have not been replayed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
