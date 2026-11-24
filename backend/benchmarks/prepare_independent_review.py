"""Prepare blank independent-review manifests and validate completed reviews.

No document content is extracted and no model is contacted. Only source fields
are copied; annotations and predictions are deliberately excluded.
"""

import argparse
import json
from pathlib import Path

from evaluate_labeled import MAX_MANIFEST_BYTES, _manifest, _pdf
from reconcile_labeled_reviews import _require_same_source

SOURCE_FIELDS = (
    "id", "original", "revised", "original_sha256", "revised_sha256", "source_kind",
)
OPTIONAL_SOURCE_FIELDS = ("original_ocr_pages", "revised_ocr_pages")


def _source_cases(path: Path) -> tuple[Path, list[dict], str]:
    resolved = path.resolve()
    version, cases, digest = _manifest(resolved)
    if version != 2:
        raise ValueError("Review preparation requires a version-2 SHA-pinned source manifest")
    # Validate the entire source set before creating a review or accepting one.
    for case in cases:
        for role in ("original", "revised"):
            _pdf(resolved.parent, case.get(role), case[f"{role}_sha256"])
    return resolved, cases, digest


def _blank_case(case: dict) -> dict:
    result = {field: case[field] for field in SOURCE_FIELDS}
    for field in OPTIONAL_SOURCE_FIELDS:
        if field in case:
            result[field] = sorted(case[field])
    for field in ("issuer_group", "event_group"):
        if field in case:
            result[field] = case[field]
    result.update(
        label_method="independent_human", expected_pairs=[], review_complete=False,
    )
    return result


def prepare_review(source: Path, *, output: Path) -> dict:
    """Create one exclusive, label-free review copy next to pinned source PDFs."""
    resolved, cases, digest = _source_cases(source)
    target = output.resolve()
    if target.parent != resolved.parent or target.suffix.lower() != ".json":
        raise ValueError("Output must be a new JSON file in the dataset folder")
    payload = {"version": 2, "cases": [_blank_case(case) for case in cases]}
    encoded = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if len(encoded) > MAX_MANIFEST_BYTES:
        raise ValueError("Prepared review exceeds the manifest size limit")
    with target.open("xb") as handle:
        handle.write(encoded)
    return {
        "source_manifest_sha256": digest, "case_count": len(cases),
        "review_complete": False, "note": "Blank review, not a scoring manifest.",
    }


def check_review(source: Path, *, review: Path) -> dict:
    """Validate a finished human review against the source set without scoring."""
    resolved, cases, digest = _source_cases(source)
    candidate = review.resolve()
    if candidate == resolved or candidate.parent != resolved.parent:
        raise ValueError("Use a separate review manifest in the dataset folder")
    version, reviews, review_digest = _manifest(candidate)
    if version != 2:
        raise ValueError("Completed review must be a version-2 SHA-pinned manifest")
    expected = {case["id"]: case for case in cases}
    supplied = {case["id"]: case for case in reviews}
    if expected.keys() != supplied.keys():
        raise ValueError("Completed review must cover the exact source case IDs")
    for case_id, case in supplied.items():
        _require_same_source(expected[case_id], case)
        if case.get("review_complete") is not True or case["label_method"] != "independent_human":
            raise ValueError(f"{case_id}: declare independent_human and explicitly complete review")
    return {
        "source_manifest_sha256": digest,
        "review_manifest_sha256": review_digest,
        "case_count": len(reviews),
        "completed_case_count": len(reviews),
        "zero_pair_case_count": sum(not case["expected_pairs"] for case in reviews),
        "labeled_pair_count": sum(len(case["expected_pairs"]) for case in reviews),
        "note": "Source and completion checks only; human independence is not authenticated.",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Version-2 pinned source manifest")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--output", type=Path, help="Create a blank reviewer copy")
    mode.add_argument("--check", type=Path, help="Check a completed reviewer copy")
    args = parser.parse_args(argv)
    try:
        result = (
            prepare_review(args.source, output=args.output)
            if args.output is not None else check_review(args.source, review=args.check)
        )
    except (OSError, ValueError, KeyError, RecursionError) as exc:
        parser.error(str(exc))
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
