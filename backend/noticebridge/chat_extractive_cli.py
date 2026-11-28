"""Run the local extractive-answer proposal experiment from a private request."""

import argparse
import asyncio
import json
import sys
from pathlib import Path

from .chat_embeddings import EmbeddingError
from .chat_extractive import extract_local
from .chat_selection import MAX_REQUEST_BYTES, parse_request
from .compare_cli import CliError, _destination, _publish_report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--digest", required=True)
    parser.add_argument("--allow-local-processing", action="store_true")
    args = parser.parse_args(argv)
    try:
        if not args.allow_local_processing:
            raise EmbeddingError("Explicit local-processing consent is required.")
        _destination(args.output)
        with args.request.open("rb") as stream:
            request = parse_request(stream.read(MAX_REQUEST_BYTES + 1))
        result = asyncio.run(extract_local(
            request, model=args.model, digest=args.digest, consent=True,
        ))
        _publish_report(args.output, (json.dumps(result, indent=2) + "\n").encode("utf-8"))
    except (EmbeddingError, CliError, OSError):
        print("Local extractive proposal failed. Check settings and files.", file=sys.stderr)
        return 2
    print("Unverified extractive proposal written. Inspect complete source passages.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
