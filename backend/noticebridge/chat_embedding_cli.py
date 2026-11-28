"""Run the opt-in embedding experiment using a private local request file."""

import argparse
import asyncio
import json
import sys
from pathlib import Path

from .chat_embeddings import MAX_INPUT_BYTES, EmbeddingError, parse_request, retrieve_local
from .compare_cli import CliError, _destination, _publish_report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", required=True, help="Exact installed local model name")
    parser.add_argument("--digest", required=True, help="Exact installed model SHA-256 digest")
    parser.add_argument(
        "--allow-local-processing", action="store_true",
        help="Confirm trusted local-only Ollama; send question and fragments to loopback",
    )
    args = parser.parse_args(argv)
    try:
        if not args.allow_local_processing:
            raise EmbeddingError("Explicit local-processing consent is required.")
        _destination(args.output)
        with args.request.open("rb") as stream:
            raw = stream.read(MAX_INPUT_BYTES + 1)
        request = parse_request(raw)
        result = asyncio.run(retrieve_local(
            request, model=args.model, digest=args.digest, consent=True,
        ))
        _publish_report(args.output, (json.dumps(result, indent=2) + "\n").encode("utf-8"))
    except (EmbeddingError, CliError, OSError):
        # Never print a request path, source quote, HTTP response or model output.
        print("Embedding experiment failed. Check local settings and files.", file=sys.stderr)
        return 2
    print("Local candidate ranking written; no answer or authority verified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
