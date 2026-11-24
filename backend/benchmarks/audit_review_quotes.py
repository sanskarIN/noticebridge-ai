"""Audit human label quotations against native extracted lines of pinned local PDFs.

Use only trusted, permission-safe local evaluation files. This developer tool
does not run the API worker, OCR, model inference or matching predictions.
A native extraction mismatch is a review flag, not proof of a fabricated quote.
"""

import argparse
import json
from collections import Counter
from pathlib import Path

from evaluate_labeled import _key, _manifest, _pdf, _require_ready_for_scoring

from noticebridge.compare import normalize
from noticebridge.extract import ExtractedDocument, extract_pdf

MAX_REVIEW_FLAGS = 100


def _native_index(document: ExtractedDocument) -> Counter:
    return Counter(
        (line.evidence.page, normalize(line.text))
        for line in document.lines
        if line.evidence.extraction_method == "native"
    )


def _status(
    document: ExtractedDocument, index: Counter, page: int, quote: str,
    occurrence: int, selected_ocr: set[int],
) -> str:
    if page > document.summary.page_count:
        return "page_out_of_bounds"
    if page in selected_ocr or page in document.summary.pages_without_text:
        return "requires_visual_review"
    if page in document.summary.pages_with_unchecked_images:
        return "requires_visual_review"
    available = index[page, quote]
    if not available:
        return "native_quote_not_found"
    if available < occurrence:
        return "native_occurrence_shortfall"
    return "native_exact"


def audit_review_quotes(manifest: Path) -> dict:
    """Report native evidence presence, never actual quotations or model guesses."""
    resolved = manifest.resolve()
    version, cases, digest = _manifest(resolved)
    if version != 2:
        raise ValueError("Quote auditing requires a version-2 SHA-pinned manifest")
    _require_ready_for_scoring(cases)
    totals: Counter = Counter()
    details = []
    summaries = []
    for case in cases:
        documents = {}
        for role in ("original", "revised"):
            content = _pdf(resolved.parent, case.get(role), case[f"{role}_sha256"])
            documents[role] = extract_pdf(
                content, document_id=role, filename=Path(case[role]).name,
                enable_ocr=False,
            )
        indexes = {role: _native_index(document) for role, document in documents.items()}
        selected = {
            role: set(case.get(f"{role}_ocr_pages", []))
            for role in documents
        }
        counts: Counter = Counter()
        occurrences: Counter = Counter()
        for pair_index, pair in enumerate(case["expected_pairs"], start=1):
            key = _key(pair)
            occurrences[key] += 1
            # Repeated identical normalized pairs require repeated source lines.
            # Distinct pairs can legitimately reuse one endpoint; do not add
            # their multiplicities together and mislabel one-to-many reviews.
            for role, offset in (("original", 0), ("revised", 2)):
                page, quote = key[offset:offset + 2]
                status = _status(
                    documents[role], indexes[role], page, quote,
                    occurrences[key], selected[role],
                )
                counts[status] += 1
                if status != "native_exact" and len(details) < MAX_REVIEW_FLAGS:
                    details.append({
                        "case_id": case["id"], "pair_index": pair_index,
                        "role": role, "page": page, "status": status,
                    })
        totals.update(counts)
        summaries.append({
            "id": case["id"], "pair_count": len(case["expected_pairs"]),
            "endpoint_counts": dict(sorted(counts.items())),
        })
    endpoints = sum(totals.values())
    flagged = endpoints - totals["native_exact"]
    return {
        "manifest_sha256": digest,
        "case_count": len(cases),
        "zero_pair_case_count": sum(not case["expected_pairs"] for case in cases),
        "labeled_endpoint_count": endpoints,
        "endpoint_counts": dict(sorted(totals.items())),
        "flagged_endpoint_count": flagged,
        "review_flags": details,
        "omitted_review_flag_count": flagged - len(details),
        "all_labeled_endpoints_native_exact": not flagged if endpoints else None,
        "cases": summaries,
        "note": (
            "Native extracted-line matching only; not visual, OCR, semantic, "
            "completeness, reviewer independence or issuer verification. "
            "A zero-pair case has no positive quotation to audit."
        ),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument(
        "--require-native-exact", action="store_true",
        help="Fail if any endpoint is flagged or no positive endpoint exists",
    )
    args = parser.parse_args(argv)
    try:
        report = audit_review_quotes(args.manifest)
    except (OSError, ValueError, KeyError, RecursionError) as exc:
        parser.error(str(exc))
    print(json.dumps(report, indent=2))
    return (
        1 if args.require_native_exact
        and report["all_labeled_endpoints_native_exact"] is not True else 0
    )


if __name__ == "__main__":
    raise SystemExit(main())
