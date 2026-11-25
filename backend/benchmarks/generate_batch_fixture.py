"""Generate a fictional three-case batch for local demonstrations and integration tests.

The PDFs are invented, explicitly marked as fictional, and contain no personal
information. The resulting reports are produced by the real isolated engine;
this fixture is not independent evidence of real-world accuracy.
"""

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import pymupdf as fitz
from generate_demo import generate_pdf

from noticebridge.batch_cli import (
    BatchError,
    prepare_manifest,
    run_batch,
    verify_batch,
)
from noticebridge.compare_cli import CliError


@dataclass(frozen=True)
class Example:
    title: str
    original: tuple[str, ...]
    revised: tuple[str, ...]
    blank_revised_page: bool = False


EXAMPLES = (
    Example(
        "Fictional grant notice",
        ("Application deadline: 13 December 2026", "Application fee: Rs. 500"),
        ("Application deadline: 19 December 2026", "Application fee: Rs. 350"),
    ),
    Example(
        "Fictional course notice",
        ("Registration deadline: 10 December 2026",),
        ("Registration deadline: 12 December 2026",),
        blank_revised_page=True,
    ),
    Example(
        "Fictional examination notice",
        ("Application deadline: 14 December 2026",),
        ("Application deadline: 14 December 2026",
         "Application deadline: 16 December 2026"),
    ),
)


def generate_sources(output: Path) -> Path:
    """Create a new folder and an explicitly ordered, unpinned plan.

    No existing directory, report, manifest or PDF is overwritten.
    """
    try:
        output.mkdir(mode=0o700, parents=False, exist_ok=False)
    except OSError as exc:
        raise BatchError("Choose a new output folder in an existing directory.") from exc
    cases = []
    for number, example in enumerate(EXAMPLES, 1):
        original = output / f"case-{number:03d}-original.pdf"
        revised = output / f"case-{number:03d}-revised.pdf"
        generate_pdf(original, title=example.title, lines=list(example.original))
        generate_pdf(revised, title=example.title, lines=list(example.revised))
        if example.blank_revised_page:
            # Exercise incomplete extraction rather than claiming that all
            # source pages yielded text. This is an intentionally empty page.
            with fitz.open(revised) as document:
                document.new_page()
                document.saveIncr()
        cases.append({"original": original.name, "revised": revised.name})
    plan = output / "plan.json"
    with plan.open("x", encoding="utf-8") as handle:
        json.dump({"version": 1, "cases": cases}, handle, indent=2)
        handle.write("\n")
    return plan


def generate_batch_fixture(output: Path, *, replay: bool = False) -> dict:
    """Exercise production pinning and batch execution, optionally replay."""
    plan = generate_sources(output)
    manifest = output / "manifest.json"
    prepared = prepare_manifest(plan, manifest)
    batch_directory = output / "batch"
    index = run_batch(manifest, batch_directory)
    if not index["complete"]:
        raise BatchError("Fictional fixture comparison did not complete.")
    if index["manifest_sha256"] != prepared["manifest_sha256"]:
        raise BatchError("Fictional fixture manifest fingerprint changed.")
    if replay:
        verify_batch(manifest, batch_directory)
    return {
        "format": "noticebridge-fictional-batch-demo",
        "manifest_sha256": index["manifest_sha256"],
        "case_count": index["case_count"],
        "completed_count": index["completed_count"],
        "status_counts": index["status_counts"],
        "engine_replayed": replay,
        "authority_verified": False,
        "synthetic": True,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = generate_batch_fixture(args.output, replay=args.verify)
    except (BatchError, CliError, OSError, RuntimeError, ValueError):
        print("Unable to generate a complete fictional batch fixture.", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
