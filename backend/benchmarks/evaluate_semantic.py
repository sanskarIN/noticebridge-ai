"""Opt-in incremental local AI evaluation on SHA-pinned PDF pairs."""

import argparse
import json
import os
from collections import Counter
from pathlib import Path
from time import perf_counter

from evaluate_labeled import _key, _manifest, _pdf, _ratio

from noticebridge.compare import normalize
from noticebridge.extract import InvalidDocument
from noticebridge.isolation import ProcessingFailed, ProcessingTimedOut, run_isolated_comparison
from noticebridge.models import ComparisonReport
from noticebridge.semantic import DEFAULT_MODEL, MODEL_PATTERN

OUTCOMES = ("no_candidates", "unavailable", "no_verified_pairs", "proposals_added")


def _pairs(report: ComparisonReport, *, proposals: bool = False) -> Counter:
    result: Counter = Counter()
    for finding in report.findings:
        if (
            (finding.match_method == "semantic_proposal") != proposals
            or finding.status not in ("possible_change", "confirmed_change")
            or finding.original is None or finding.revised is None
        ):
            continue
        result[(
            finding.original.page, normalize(finding.original.text),
            finding.revised.page, normalize(finding.revised.text),
        )] += 1
    return result


def _require_additive(baseline: ComparisonReport, assisted: ComparisonReport) -> None:
    """Compare the independently computed reports, not just aggregate counts."""
    proposals = [f for f in assisted.findings if f.match_method == "semantic_proposal"]
    proposal_ids = {f.id for f in proposals}
    ignored = {"findings", "checklist", "warnings", "semantic_assistance"}
    if (
        baseline.semantic_assistance != "not_requested"
        or assisted.semantic_assistance not in OUTCOMES
        or baseline.model_dump(exclude=ignored) != assisted.model_dump(exclude=ignored)
        or baseline.findings != [
            f for f in assisted.findings if f.match_method != "semantic_proposal"
        ]
        or baseline.checklist != [
            item for item in assisted.checklist if item.finding_id not in proposal_ids
        ]
        or assisted.warnings[:len(baseline.warnings)] != baseline.warnings
        or (assisted.semantic_assistance == "proposals_added") != bool(proposals)
        or any(
            f.status != "possible_change" or f.authority_verified or f.field_changes
            for f in proposals
        )
    ):
        raise ValueError("Assisted result did not preserve the deterministic comparison")


def _counts(gold: Counter, predicted: Counter) -> dict:
    return {
        "true_positive": sum((gold & predicted).values()),
        "false_positive": sum((predicted - gold).values()),
        "false_negative": sum((gold - predicted).values()),
    }


def _score_case(case: dict, original: bytes, revised: bytes, *, enable_ocr: bool) -> dict:
    options = {
        "old_name": Path(case["original"]).name,
        "new_name": Path(case["revised"]).name,
        "enable_ocr": enable_ocr,
        "original_ocr_pages": tuple(case.get("original_ocr_pages", [])) if enable_ocr else (),
        "revised_ocr_pages": tuple(case.get("revised_ocr_pages", [])) if enable_ocr else (),
    }
    start = perf_counter()
    baseline = run_isolated_comparison(original, revised, enable_semantic=False, **options)
    baseline_seconds = perf_counter() - start
    for document in baseline.documents:
        if any(
            pair[f"{document.id}_page"] > document.page_count
            for pair in case["expected_pairs"]
        ):
            raise ValueError(f"{case['id']}: labeled page is outside the {document.id} PDF")
    start = perf_counter()
    assisted = run_isolated_comparison(original, revised, enable_semantic=True, **options)
    assisted_seconds = perf_counter() - start
    _require_additive(baseline, assisted)
    gold = Counter(_key(pair) for pair in case["expected_pairs"])
    deterministic = _pairs(baseline)
    proposals = _pairs(assisted, proposals=True)
    # Duplicate proposals for already matched evidence cannot earn recovery credit.
    remaining = gold - deterministic
    recovered = sum((remaining & proposals).values())
    added = sum(proposals.values())
    return {
        "id": case["id"],
        "source_kind": case["source_kind"],
        "label_method": case["label_method"],
        "input_sha256": {doc.id: doc.sha256 for doc in baseline.documents},
        "semantic_assistance": assisted.semantic_assistance,
        "baseline": _counts(gold, deterministic),
        "assisted": _counts(gold, deterministic + proposals),
        "proposal_count": added,
        "recovered_pair_count": recovered,
        "unsupported_or_redundant_proposal_count": added - recovered,
        "baseline_missed_pair_count": sum(remaining.values()),
        "text_coverage": baseline.text_coverage,
        "fuzzy_matching_limited": baseline.fuzzy_matching_limited,
        "unchecked_image_page_count": sum(
            len(doc.pages_with_unchecked_images) for doc in baseline.documents
        ),
        "baseline_seconds": round(baseline_seconds, 3),
        "assisted_seconds": round(assisted_seconds, 3),
    }


def _summary(cases: list[dict]) -> dict:
    modes = {}
    for mode in ("baseline", "assisted"):
        counts = {
            field: sum(case[mode][field] for case in cases)
            for field in ("true_positive", "false_positive", "false_negative")
        }
        tp = counts["true_positive"]
        modes[mode] = {
            **counts,
            "precision": _ratio(tp, tp + counts["false_positive"]),
            "recall": _ratio(tp, tp + counts["false_negative"]),
        }
    proposals = sum(case["proposal_count"] for case in cases)
    recovered = sum(case["recovered_pair_count"] for case in cases)
    missed = sum(case["baseline_missed_pair_count"] for case in cases)
    return {
        "case_count": len(cases),
        "distinct_pdf_pair_count": len({
            tuple(sorted(case["input_sha256"].values())) for case in cases
        }),
        "outcomes": {
            outcome: sum(case["semantic_assistance"] == outcome for case in cases)
            for outcome in OUTCOMES
        },
        **modes,
        "proposal_count": proposals,
        "recovered_pair_count": recovered,
        "unsupported_or_redundant_proposal_count": proposals - recovered,
        "baseline_missed_pair_count": missed,
        "incremental_proposal_precision": _ratio(recovered, proposals),
        "baseline_miss_recovery": _ratio(recovered, missed),
        "incomplete_case_count": sum(
            case["text_coverage"] != "all_pages_have_text" for case in cases
        ),
        "unchecked_image_case_count": sum(case["unchecked_image_page_count"] > 0 for case in cases),
        "limited_matching_case_count": sum(case["fuzzy_matching_limited"] for case in cases),
        "baseline_seconds": round(sum(case["baseline_seconds"] for case in cases), 3),
        "assisted_seconds": round(sum(case["assisted_seconds"] for case in cases), 3),
    }


def evaluate_semantic(manifest: Path, *, enable_ocr: bool = False) -> dict:
    """Run a local model experiment, distinct from deterministic evaluation."""
    model = os.environ.get("NOTICEBRIDGE_LOCAL_MODEL", DEFAULT_MODEL)
    if not MODEL_PATTERN.fullmatch(model):
        raise ValueError("Invalid local model name")
    manifest = manifest.resolve()
    version, cases, digest = _manifest(manifest)
    if version != 2:
        raise ValueError("Semantic evaluation requires a version-2 SHA-pinned manifest")
    results = []
    for case in cases:
        old = _pdf(manifest.parent, case.get("original"), case["original_sha256"])
        new = _pdf(manifest.parent, case.get("revised"), case["revised_sha256"])
        results.append(_score_case(case, old, new, enable_ocr=enable_ocr))
    independent = [
        case for case in results
        if case["source_kind"] in ("public_notice", "consented")
        and case["label_method"] == "independent_human"
    ]
    return {
        "manifest_sha256": digest,
        "requested_local_model": model,
        "ocr_enabled": enable_ocr,
        "overall": _summary(results),
        "declared_independent_nonfictional": _summary(independent),
        "cases": results,
        "warning": (
            "Exact page/quotation alignment only; proposals are unverified and never "
            "confirmed changes. Source and label provenance are operator declarations. "
            "The local model name is not a weight fingerprint. No quotes are exported."
        ),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument(
        "--run-local-model", action="store_true", required=True,
        help="Explicitly allow unmatched PDF excerpts to reach the loopback Ollama endpoint",
    )
    parser.add_argument("--enable-ocr", action="store_true")
    parser.add_argument("--min-independent-proposal-precision", type=float)
    parser.add_argument("--min-independent-miss-recovery", type=float)
    parser.add_argument("--min-independent-distinct-pairs", type=int)
    args = parser.parse_args(argv)
    for threshold in (
        args.min_independent_proposal_precision, args.min_independent_miss_recovery,
    ):
        if threshold is not None and not 0 <= threshold <= 1:
            parser.error("Thresholds must be between 0 and 1")
    if args.min_independent_distinct_pairs is not None and args.min_independent_distinct_pairs < 1:
        parser.error("Minimum independent distinct-pair count must be positive")
    try:
        report = evaluate_semantic(args.manifest, enable_ocr=args.enable_ocr)
    except (OSError, ValueError, InvalidDocument, ProcessingFailed, ProcessingTimedOut) as exc:
        parser.error(str(exc))
    print(json.dumps(report, indent=2, ensure_ascii=False))
    overall = report["overall"]
    independent = report["declared_independent_nonfictional"]
    if overall["outcomes"]["unavailable"] or overall["proposal_count"] == 0:
        return 1
    for denominator, threshold in (
        (independent["proposal_count"], args.min_independent_proposal_precision),
        (independent["baseline_missed_pair_count"], args.min_independent_miss_recovery),
    ):
        if threshold is not None and (
            not denominator or independent["recovered_pair_count"] / denominator < threshold
        ):
            return 1
    if args.min_independent_distinct_pairs is not None and (
        independent["distinct_pdf_pair_count"] < args.min_independent_distinct_pairs
        or independent["case_count"] != independent["distinct_pdf_pair_count"]
        or independent["proposal_count"] == 0
    ):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
