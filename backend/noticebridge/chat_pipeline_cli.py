"""Run a two-stage local evidence proposal workflow; no answer prose is imported."""

import argparse
import asyncio
import sys
from pathlib import Path

from .chat_embeddings import EmbeddingError
from .chat_pipeline import MAX_REQUEST_BYTES, encode, parse_request, run_pipeline
from .compare_cli import CliError, _destination, _publish_report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--embedding-model", required=True)
    parser.add_argument("--embedding-digest", required=True)
    parser.add_argument("--answer-model", required=True)
    parser.add_argument("--answer-digest", required=True)
    parser.add_argument("--allow-local-processing", action="store_true")
    args = parser.parse_args(argv)
    try:
        if not args.allow_local_processing:
            raise EmbeddingError("Explicit local-processing consent is required.")
        _destination(args.output)
        with args.request.open("rb") as stream:
            request = parse_request(stream.read(MAX_REQUEST_BYTES + 1))
        result = asyncio.run(run_pipeline(
            request, embedding_model=args.embedding_model, embedding_digest=args.embedding_digest,
            answer_model=args.answer_model, answer_digest=args.answer_digest, consent=True,
        ))
        _publish_report(args.output, encode(result))
    except (EmbeddingError, CliError, OSError):
        print("Local pipeline failed. Check settings and files.", file=sys.stderr)
        return 2
    print("Local proposal written. Review original evidence; authority is not verified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
