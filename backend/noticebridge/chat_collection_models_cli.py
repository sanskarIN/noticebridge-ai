"""Process a collection model manifest with a trusted local-only runtime."""

import argparse
import asyncio
import sys
from pathlib import Path

from .chat_collection_models import (
    MAX_MANIFEST_BYTES,
    parse_manifest,
    preflight_collection,
    read_requests,
    run_collection,
)
from .chat_embeddings import EmbeddingError
from .compare_cli import CliError, _destination, _publish_report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--request-directory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--embedding-model")
    parser.add_argument("--embedding-digest")
    parser.add_argument("--answer-model")
    parser.add_argument("--answer-digest")
    parser.add_argument(
        "--preflight-only", action="store_true",
        help="Validate all requests and write candidate counts without invoking a model.",
    )
    parser.add_argument("--allow-local-processing", action="store_true")
    args = parser.parse_args(argv)
    try:
        model_options = (
            args.embedding_model, args.embedding_digest,
            args.answer_model, args.answer_digest,
        )
        if args.preflight_only:
            if args.allow_local_processing or any(value is not None for value in model_options):
                raise EmbeddingError("Preflight does not accept model processing options.")
        elif not args.allow_local_processing or not all(model_options):
            raise EmbeddingError("Explicit consent and all four model settings are required.")
        _destination(args.output)
        with args.manifest.open("rb") as stream:
            manifest = parse_manifest(stream.read(MAX_MANIFEST_BYTES + 1))
        requests = read_requests(manifest, args.request_directory)
        if args.preflight_only:
            output = preflight_collection(manifest, requests)
        else:
            output = asyncio.run(run_collection(
                manifest, requests, embedding_model=args.embedding_model,
                embedding_digest=args.embedding_digest, answer_model=args.answer_model,
                answer_digest=args.answer_digest, consent=True,
            ))
        _publish_report(args.output, output)
    except (EmbeddingError, CliError, OSError):
        print("Collection local model workflow failed. Check settings and files.", file=sys.stderr)
        return 2
    if args.preflight_only:
        print("Collection candidate inventory written. No model was invoked.")
    else:
        print("Collection proposal bundle written. Review source evidence; authority is not verified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
