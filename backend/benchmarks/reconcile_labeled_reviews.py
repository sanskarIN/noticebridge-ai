"""Reconcile two human-labeled, SHA-pinned NoticeBridge evaluation manifests."""

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

from evaluate_labeled import CASE_ID, MAX_MANIFEST_BYTES, _key, _manifest, _pdf


def _load_review(path: Path, root: Path) -> tuple[dict[str, dict], str]:
    if path.resolve().parent != root:
        raise ValueError("Review manifests must reside in the same dataset folder")
    version, cases, digest = _manifest(path)
    if version != 2:
        raise ValueError("Each review must be a version-2 SHA-pinned manifest")
    for case in cases:
        if case["label_method"] != "independent_human" or case.get("review_complete") is not True:
            raise ValueError(
                f"{case['id']}: declare independent_human and explicitly set review_complete"
            )
    return {case["id"]: case for case in cases}, digest


def _identity(case: dict) -> tuple:
    return (
        case["original"], case["revised"], case["original_sha256"], case["revised_sha256"],
        case["source_kind"],
        tuple(sorted(case.get("original_ocr_pages", []))),
        tuple(sorted(case.get("revised_ocr_pages", []))),
    )


def _require_same_source(first: dict, second: dict) -> None:
    if _identity(first) != _identity(second):
        raise ValueError(f"{first['id']}: reviews disagree on the source or OCR page selections")


def reconcile_reviews(
    first_path: Path, second_path: Path, *, reviewer_a: str, reviewer_b: str,
    adjudication_path: Path | None = None, adjudicator: str | None = None,
) -> tuple[dict, dict | None]:
    """Return an aggregate audit and, if all disagreements are resolved, an evaluation manifest."""
    if (adjudication_path is None) != (adjudicator is None):
        raise ValueError("Supply both an adjudication manifest and its adjudicator ID")
    reviewers = [reviewer_a, reviewer_b]
    if adjudicator is not None:
        reviewers.append(adjudicator)
    if (
        any(not CASE_ID.fullmatch(reviewer) for reviewer in reviewers)
        or len({reviewer.casefold() for reviewer in reviewers}) != len(reviewers)
    ):
        raise ValueError("Use a different URL-safe reviewer ID for each person")

    paths = [first_path, second_path]
    if adjudication_path is not None:
        paths.append(adjudication_path)
    if len({path.resolve() for path in paths}) != len(paths):
        raise ValueError("Use a separate manifest file for each review")
    root = first_path.resolve().parent
    first, first_sha = _load_review(first_path, root)
    second, second_sha = _load_review(second_path, root)
    if first.keys() != second.keys():
        raise ValueError("Both reviews must cover the exact same case IDs")
    decisions, decisions_sha = (
        _load_review(adjudication_path, root) if adjudication_path else ({}, None)
    )
    audit_cases = []
    evaluation_cases = []
    disagreements: set[str] = set()
    for case_id, original in first.items():
        alternate = second[case_id]
        _require_same_source(original, alternate)
        for role in ("original", "revised"):
            _pdf(root, original[role], original[f"{role}_sha256"])

        a = Counter(_key(pair) for pair in original["expected_pairs"])
        b = Counter(_key(pair) for pair in alternate["expected_pairs"])
        decision = decisions.get(case_id)
        if a != b:
            disagreements.add(case_id)
        if decision is not None:
            _require_same_source(original, decision)

        audit_cases.append({
            "id": case_id,
            "both": sum((a & b).values()),
            "reviewer_a_only": sum((a - b).values()),
            "reviewer_b_only": sum((b - a).values()),
            "resolution": "agreed" if a == b else "adjudicated" if decision else "unresolved",
        })
        chosen = decision or original
        # Preserve the selected reviewer's original quotations and their occurrences.
        evaluation_cases.append({
            **original, "expected_pairs": chosen["expected_pairs"],
        })

    if adjudication_path is not None and decisions.keys() != disagreements:
        raise ValueError("The adjudication must cover exactly the cases with label disagreements")
    totals = {
        field: sum(case[field] for case in audit_cases)
        for field in ("both", "reviewer_a_only", "reviewer_b_only")
    }
    denominator = 2 * totals["both"] + totals["reviewer_a_only"] + totals["reviewer_b_only"]
    audit = {
        "review_manifests": [
            {"reviewer": reviewer_a, "sha256": first_sha},
            {"reviewer": reviewer_b, "sha256": second_sha},
        ],
        "adjudication_manifest": {"reviewer": adjudicator, "sha256": decisions_sha}
        if decisions_sha is not None else None,
        "case_count": len(audit_cases),
        "agreed_case_count": len(audit_cases) - len(disagreements),
        "unresolved_case_count": len(disagreements - decisions.keys()),
        "pair_counts": totals,
        "positive_pair_agreement": 2 * totals["both"] / denominator if denominator else None,
        "cases": audit_cases,
        "note": "Reviewer IDs and independence are operator declarations.",
    }
    if audit["unresolved_case_count"]:
        return audit, None
    return audit, {"version": 2, "cases": evaluation_cases, "label_review": audit}


def verify_reconciled_manifest(path: Path, expected: dict, *, root: Path) -> None:
    """Check a saved result against freshly reconciled reviews without rewriting it."""
    if path.resolve().parent != root or path.suffix.lower() != ".json":
        raise ValueError("Verification requires a JSON manifest in the dataset folder")
    version, _, actual_digest = _manifest(path)
    canonical = json.dumps(
        expected, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
    ).encode("utf-8")
    if version != 2 or actual_digest != hashlib.sha256(canonical).hexdigest():
        raise ValueError("Saved reconciliation does not match the supplied reviews and audit")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("first", type=Path, help="First reviewer's pinned manifest")
    parser.add_argument("second", type=Path, help="Second reviewer's pinned manifest")
    parser.add_argument("--reviewer-a", required=True, help="Pseudonymous first reviewer ID")
    parser.add_argument("--reviewer-b", required=True, help="Pseudonymous second reviewer ID")
    parser.add_argument("--adjudication", type=Path, help="Reviewed decisions for disputed cases")
    parser.add_argument("--adjudicator", help="Pseudonymous third reviewer ID")
    destination = parser.add_mutually_exclusive_group()
    destination.add_argument("--output", type=Path, help="Create a new version-2 manifest if resolved")
    destination.add_argument(
        "--verify", type=Path, help="Verify an existing resolved manifest without modifying it",
    )
    args = parser.parse_args(argv)
    try:
        audit, manifest = reconcile_reviews(
            args.first, args.second, reviewer_a=args.reviewer_a, reviewer_b=args.reviewer_b,
            adjudication_path=args.adjudication, adjudicator=args.adjudicator,
        )
        if args.verify is not None:
            if manifest is None:
                raise ValueError("Cannot verify a reconciled manifest with unresolved disagreements")
            verify_reconciled_manifest(
                args.verify, manifest, root=args.first.resolve().parent,
            )
        if args.output is not None and manifest is not None:
            output = args.output.resolve()
            if output.parent != args.first.resolve().parent or output.suffix.lower() != ".json":
                raise ValueError("Output must be a new JSON file in the dataset folder")
            encoded = (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
            if len(encoded) > MAX_MANIFEST_BYTES:
                raise ValueError("Reconciled manifest exceeds the evaluation manifest size limit")
            with output.open("xb") as handle:
                handle.write(encoded)
    except (OSError, ValueError, KeyError, RecursionError) as exc:
        parser.error(str(exc))
    print(json.dumps(audit, indent=2))
    return 1 if manifest is None else 0


if __name__ == "__main__":
    raise SystemExit(main())
