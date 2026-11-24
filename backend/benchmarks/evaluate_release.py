"""Freeze and score a local, independently reviewed deterministic release evaluation."""

import argparse
import hashlib
import json
from pathlib import Path

from audit_evaluation_split import audit_split
from evaluate_labeled import MAX_CASES, SHA256_PATTERN, _unique_object, evaluate_labeled
from reconcile_labeled_reviews import reconcile_reviews, verify_reconciled_manifest

from noticebridge.isolation import ProcessingFailed, ProcessingTimedOut

MAX_CONFIG_BYTES = 4096
MINIMUM_RATIOS = ("min_precision", "min_recall")
MAXIMUM_COUNTS = (
    "max_unsupported_confirmed", "max_incomplete_cases",
    "max_unchecked_image_cases", "max_limited_matching_cases",
)


def _read_config(path: Path) -> tuple[dict, str]:
    with path.open("rb") as handle:
        data = handle.read(MAX_CONFIG_BYTES + 1)
    if len(data) > MAX_CONFIG_BYTES:
        raise ValueError("Evaluation policy or plan exceeds 4 KiB")
    value = json.loads(data.decode("utf-8"), object_pairs_hook=_unique_object)
    if not isinstance(value, dict):
        raise ValueError("Evaluation policy or plan must be a JSON object")
    return value, hashlib.sha256(data).hexdigest()


def _validate_policy(policy: dict) -> None:
    if policy.keys() != {
        "min_cases", "min_issuer_groups", "enable_ocr", *MINIMUM_RATIOS, *MAXIMUM_COUNTS,
    }:
        raise ValueError("Policy must specify every release threshold and the OCR setting")
    for key in ("min_cases", "min_issuer_groups"):
        if type(policy[key]) is not int or not 1 <= policy[key] <= MAX_CASES:
            raise ValueError(f"{key} must be an integer from 1 to {MAX_CASES}")
    for key in MINIMUM_RATIOS:
        if type(policy[key]) not in (int, float) or not 0 <= policy[key] <= 1:
            raise ValueError(f"{key} must be a number from 0 to 1")
    for key in MAXIMUM_COUNTS:
        if type(policy[key]) is not int or policy[key] < 0:
            raise ValueError(f"{key} must be a nonnegative integer")
    if type(policy["enable_ocr"]) is not bool:
        raise ValueError("enable_ocr must be a JSON boolean")


def build_plan(
    development: Path, heldout: Path, first: Path, second: Path, *,
    reviewer_a: str, reviewer_b: str, policy: dict,
    adjudication_path: Path | None = None, adjudicator: str | None = None,
) -> dict:
    """Verify the pinned corpus, review history and split without scoring any PDFs."""
    _validate_policy(policy)
    _, reconciled = reconcile_reviews(
        first, second, reviewer_a=reviewer_a, reviewer_b=reviewer_b,
        adjudication_path=adjudication_path, adjudicator=adjudicator,
    )
    if reconciled is None:
        raise ValueError("Held-out reviews still have unresolved disagreements")
    heldout_digest = verify_reconciled_manifest(heldout, reconciled, root=first.resolve().parent)
    cases = reconciled["cases"]
    if any(case["source_kind"] not in ("public_notice", "consented") for case in cases):
        raise ValueError("Every held-out case must declare a public_notice or consented source")
    if len(cases) < policy["min_cases"]:
        raise ValueError("Held-out case count falls below min_cases")
    if not any(case["expected_pairs"] for case in cases):
        raise ValueError("Held-out labels must contain a positive pair to measure recall")

    split = audit_split(development, heldout, require_event_groups=True)
    if split["heldout"]["manifest_sha256"] != heldout_digest:
        raise ValueError("Held-out manifest changed during preflight")
    if not split["passed"]:
        raise ValueError(
            "Split audit failed: check repeated pairs, shared documents, and missing or shared "
            "declared event groups with audit_evaluation_split.py --require-event-groups"
        )
    issuer_count = len({case["issuer_group"].casefold() for case in cases})
    if issuer_count < policy["min_issuer_groups"]:
        raise ValueError("Held-out issuer group count falls below min_issuer_groups")
    return {
        "version": 1,
        "development_manifest_sha256": split["development"]["manifest_sha256"],
        "heldout_manifest_sha256": heldout_digest,
        "heldout_case_count": len(cases),
        "heldout_issuer_group_count": issuer_count,
        "policy": policy,
    }


def score_plan(heldout: Path, plan: dict, *, plan_sha256: str) -> dict:
    """Score the exact held-out manifest that passed preflight, using its frozen policy."""
    policy = plan["policy"]
    result = evaluate_labeled(
        heldout, enable_ocr=policy["enable_ocr"], require_pinned_sources=True,
        expected_manifest_sha256=plan["heldout_manifest_sha256"],
    )
    counts = result["pair_counts"]
    true_positive = counts["true_positive"]
    checks = {}
    for key, error in (("min_precision", "false_positive"), ("min_recall", "false_negative")):
        denominator = true_positive + counts[error]
        checks[key] = {
            "numerator": true_positive, "denominator": denominator,
            "threshold": policy[key],
            "passed": denominator > 0 and true_positive / denominator >= policy[key],
        }
    for key, observed in (
        ("max_unsupported_confirmed", counts["unsupported_confirmed_changes"]),
        ("max_incomplete_cases", result["incomplete_case_count"]),
        ("max_unchecked_image_cases", result["unchecked_image_case_count"]),
        ("max_limited_matching_cases", result["fuzzy_matching_limited_case_count"]),
    ):
        checks[key] = {
            "observed": observed, "threshold": policy[key], "passed": observed <= policy[key],
        }
    return {
        "plan_sha256": plan_sha256,
        "plan": plan,
        "passed": all(check["passed"] for check in checks.values()),
        "checks": checks,
        "evaluation": result,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--development", required=True, type=Path, help="Pinned development data")
    common.add_argument("--heldout", required=True, type=Path, help="Reconciled held-out labels")
    common.add_argument("--review-a", required=True, type=Path, help="First completed review")
    common.add_argument("--review-b", required=True, type=Path, help="Second completed review")
    common.add_argument("--reviewer-a", required=True, help="Pseudonymous first reviewer ID")
    common.add_argument("--reviewer-b", required=True, help="Pseudonymous second reviewer ID")
    common.add_argument("--adjudication", type=Path, help="Completed review of disputed cases")
    common.add_argument("--adjudicator", help="Pseudonymous third reviewer ID")
    common.add_argument("--plan", required=True, type=Path, help="Local evaluation plan JSON")
    commands = parser.add_subparsers(dest="command", required=True)
    freeze = commands.add_parser("freeze", parents=[common], help="Preflight without scoring")
    freeze.add_argument("--policy", required=True, type=Path, help="Predeclared evaluation policy")
    score = commands.add_parser("score", parents=[common], help="Score a previously frozen plan")
    score.add_argument("--plan-sha256", required=True, help="Plan digest recorded before scoring")
    args = parser.parse_args(argv)

    try:
        if args.command == "freeze":
            policy, _ = _read_config(args.policy)
        else:
            saved, digest = _read_config(args.plan)
            if not SHA256_PATTERN.fullmatch(args.plan_sha256) or digest != args.plan_sha256:
                raise ValueError("Plan bytes do not match the previously recorded SHA-256")
            policy = saved.get("policy")
            if not isinstance(policy, dict):
                raise ValueError("Frozen plan is missing its evaluation policy")

        plan = build_plan(
            args.development, args.heldout, args.review_a, args.review_b,
            reviewer_a=args.reviewer_a, reviewer_b=args.reviewer_b, policy=policy,
            adjudication_path=args.adjudication, adjudicator=args.adjudicator,
        )
        if args.command == "freeze":
            data = (json.dumps(plan, indent=2, sort_keys=True) + "\n").encode("utf-8")
            with args.plan.open("xb") as handle:
                handle.write(data)
            print(json.dumps({"plan_sha256": hashlib.sha256(data).hexdigest(), "plan": plan}))
            return 0

        if json.dumps(saved, sort_keys=True) != json.dumps(plan, sort_keys=True):
            raise ValueError("Current corpus or review history differs from the frozen plan")
        result = score_plan(args.heldout, plan, plan_sha256=digest)
    except (
        OSError, ValueError, KeyError, RecursionError, ProcessingFailed, ProcessingTimedOut,
    ) as exc:
        parser.error(str(exc))

    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
