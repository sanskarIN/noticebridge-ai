"""Score evidence-linked change pairs against a locally labeled PDF dataset.

Ground truth is supplied by the operator; this tool does NOT verify issuers,
notice authority or the labels' quality. No cloud or model requests are made.
"""

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path, PurePosixPath, PureWindowsPath

from noticebridge.compare import normalize
from noticebridge.extract import MAX_PAGES, MAX_UPLOAD_BYTES, InvalidDocument, validate_ocr_pages
from noticebridge.isolation import ProcessingFailed, ProcessingTimedOut, run_isolated_comparison

MAX_MANIFEST_BYTES = 1_000_000
MAX_CASES = 500
MAX_GOLD_PAIRS = 500
CASE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
PAIR_FIELDS = ("original_page", "original_text", "revised_page", "revised_text")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
SOURCE_KINDS = frozenset({"fictional", "public_notice", "consented"})
LABEL_METHODS = frozenset({"synthetic", "author_reviewed", "independent_human"})


def _unique_object(entries: list[tuple[str, object]]) -> dict:
    result = dict(entries)
    if len(result) != len(entries):
        raise ValueError("Evaluation manifest contains duplicate field names")
    return result


def _manifest(path: Path) -> tuple[int, list[dict], str]:
    if path.stat().st_size > MAX_MANIFEST_BYTES:
        raise ValueError("Evaluation manifest is too large")
    payload = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_unique_object)
    if (
        not isinstance(payload, dict)
        or type(payload.get("version")) is not int
        or payload["version"] not in (1, 2)
        or not isinstance(payload.get("cases"), list)
        or not 1 <= len(payload["cases"]) <= MAX_CASES
    ):
        raise ValueError("Manifest must declare version 1 or 2 and a nonempty bounded cases list")
    version = payload["version"]
    cases = payload["cases"]
    canonical = json.dumps(
        payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
    ).encode("utf-8")
    manifest_sha256 = hashlib.sha256(canonical).hexdigest()
    ids: set[str] = set()
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError("Invalid evaluation case")
        label = case.get("id")
        if not isinstance(label, str) or not CASE_ID.fullmatch(label) or label in ids:
            raise ValueError("Case IDs must be unique and URL-safe")
        ids.add(label)
        if version == 2:
            for key in ("original_sha256", "revised_sha256"):
                digest = case.get(key)
                if not isinstance(digest, str) or not SHA256_PATTERN.fullmatch(digest):
                    raise ValueError(f"{label}: {key} must be a lowercase SHA-256 digest")
            origin = case.get("source_kind")
            method = case.get("label_method")
            if not isinstance(origin, str) or origin not in SOURCE_KINDS:
                raise ValueError(f"{label}: source_kind must identify its source category")
            if not isinstance(method, str) or method not in LABEL_METHODS:
                raise ValueError(f"{label}: label_method must identify how labels were prepared")
        pairs = case.get("expected_pairs")
        if not isinstance(pairs, list) or len(pairs) > MAX_GOLD_PAIRS:
            raise ValueError(f"{label}: expected_pairs must be a bounded array")
        for field in ("original_ocr_pages", "revised_ocr_pages"):
            try:
                validate_ocr_pages(case.get(field, []))
            except InvalidDocument as exc:
                raise ValueError(f"{label}: invalid {field}: {exc}") from exc
        for pair in pairs:
            if not isinstance(pair, dict) or not all(key in pair for key in PAIR_FIELDS):
                raise ValueError(f"{label}: incomplete labeled passage pair")
            for key in ("original_page", "revised_page"):
                if type(pair[key]) is not int or not 1 <= pair[key] <= MAX_PAGES:
                    raise ValueError(f"{label}: labeled pages must be in the range 1–{MAX_PAGES}")
            for key in ("original_text", "revised_text"):
                value = pair[key]
                if not isinstance(value, str) or not value.strip() or len(value) > 5000:
                    raise ValueError(f"{label}: labeled quotations must be bounded text")
    return version, cases, manifest_sha256


def _pdf(root: Path, relative: object, expected_sha256: str | None = None) -> bytes:
    if not isinstance(relative, str) or not relative:
        raise ValueError("PDF path must be a nonempty relative string")
    # Enforce the same relative-path rules on Linux and Windows. In
    # particular, '/tmp/x.pdf' is not considered absolute by Windows Path,
    # while 'C:\\\\x.pdf' is not recognized as absolute by POSIX Path.
    posix = PurePosixPath(relative)
    windows = PureWindowsPath(relative)
    if (
        "\\" in relative
        or posix.is_absolute()
        or windows.root
        or windows.drive
        or ".." in posix.parts
        or posix.suffix.lower() != ".pdf"
    ):
        raise ValueError("PDF path must refer to a relative .pdf under the manifest folder")
    source = Path(relative)
    resolved = (root / source).resolve()
    if not resolved.is_relative_to(root):
        raise ValueError("PDF path escapes the evaluation dataset folder")
    if not resolved.is_file() or not 0 < resolved.stat().st_size <= MAX_UPLOAD_BYTES:
        raise ValueError("PDF fixture is missing, empty, or exceeds 10 MiB")
    content = resolved.read_bytes()
    if not 0 < len(content) <= MAX_UPLOAD_BYTES:
        raise ValueError("PDF fixture changed or exceeded the 10 MiB budget")
    if expected_sha256 and hashlib.sha256(content).hexdigest() != expected_sha256:
        raise ValueError(f"PDF SHA-256 mismatch for {relative}: dataset input changed")
    return content


def _key(pair: dict) -> tuple[int, str, int, str]:
    return (
        pair["original_page"], normalize(pair["original_text"]),
        pair["revised_page"], normalize(pair["revised_text"]),
    )


def _score(
    case: dict, original: bytes, revised: bytes, *, enable_ocr: bool = False
) -> dict:
    result = run_isolated_comparison(
        original, revised,
        old_name=Path(case["original"]).name,
        new_name=Path(case["revised"]).name,
        enable_ocr=enable_ocr,
        enable_semantic=False,
        original_ocr_pages=tuple(case.get("original_ocr_pages", [])) if enable_ocr else (),
        revised_ocr_pages=tuple(case.get("revised_ocr_pages", [])) if enable_ocr else (),
    )
    for document in result.documents:
        if any(
            pair[f"{document.id}_page"] > document.page_count
            for pair in case["expected_pairs"]
        ):
            raise ValueError(f"{case['id']}: labeled page is outside the {document.id} PDF")
    gold = Counter(_key(pair) for pair in case["expected_pairs"])
    predicted = Counter()
    confirmed = Counter()
    for finding in result.findings:
        if (
            finding.status not in ("confirmed_change", "possible_change")
            or finding.original is None or finding.revised is None
        ):
            continue
        key = (
            finding.original.page, normalize(finding.original.text),
            finding.revised.page, normalize(finding.revised.text),
        )
        predicted[key] += 1
        if finding.status == "confirmed_change":
            confirmed[key] += 1
    return {
        "id": case["id"],
        "source_kind": case.get("source_kind", "unrecorded"),
        "label_method": case.get("label_method", "unrecorded"),
        "text_coverage": result.text_coverage,
        "fuzzy_matching_limited": result.fuzzy_matching_limited,
        "ocr_pages": sum(document.ocr_page_count for document in result.documents),
        "ocr_page_numbers": {document.id: document.ocr_pages for document in result.documents},
        "selected_ocr_pages": {
            document.id: document.ocr_override_pages for document in result.documents
        },
        "pages_without_text": sum(
            len(document.pages_without_text) for document in result.documents
        ),
        "expected_pairs": sum(gold.values()),
        "predicted_pairs": sum(predicted.values()),
        "true_positive": sum((gold & predicted).values()),
        "false_positive": sum((predicted - gold).values()),
        "false_negative": sum((gold - predicted).values()),
        "confirmed_true_positive": sum((confirmed & gold).values()),
        "unsupported_confirmed_changes": sum((confirmed - gold).values()),
        "processing_warnings": len(result.warnings),
    }


def _ratio(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator else None


def evaluate_labeled(
    manifest: Path, *, enable_ocr: bool = False, require_pinned_sources: bool = False,
) -> dict:
    """Run offline evidence-pair evaluation from operator-supplied ground truth.

    OCR is optional and never enables experimental semantic suggestions. Do
    not compare OCR-on metrics against OCR-off metrics without reporting the
    different extraction setting and runtime environment.
    """
    resolved = manifest.resolve()
    version, cases, manifest_sha256 = _manifest(resolved)
    if require_pinned_sources and version != 2:
        raise ValueError("Pinned sources require a version-2 manifest")
    root = resolved.parent
    results = []
    for case in cases:
        old = _pdf(
            root, case.get("original"),
            case["original_sha256"] if version == 2 else None,
        )
        new = _pdf(
            root, case.get("revised"),
            case["revised_sha256"] if version == 2 else None,
        )
        results.append(_score(case, old, new, enable_ocr=enable_ocr))
    tp = sum(case["true_positive"] for case in results)
    fp = sum(case["false_positive"] for case in results)
    fn = sum(case["false_negative"] for case in results)
    confirmed_tp = sum(case["confirmed_true_positive"] for case in results)
    unsupported_confirmed = sum(case["unsupported_confirmed_changes"] for case in results)
    return {
        "dataset": "operator-supplied labels; not independently verified",
        "manifest_version": version,
        "manifest_sha256": manifest_sha256,
        "source_kind_case_counts": dict(Counter(
            case["source_kind"] for case in results
        )),
        "label_method_case_counts": dict(Counter(
            case["label_method"] for case in results
        )),
        "case_count": len(results),
        "ocr_enabled": enable_ocr,
        "ocr_page_count": sum(case["ocr_pages"] for case in results),
        "pages_without_text_count": sum(
            case["pages_without_text"] for case in results
        ),
        "pair_counts": {
            "true_positive": tp,
            "false_positive": fp,
            "false_negative": fn,
            "unsupported_confirmed_changes": unsupported_confirmed,
        },
        "precision": _ratio(tp, tp + fp),
        "recall": _ratio(tp, tp + fn),
        "confirmed_only": {
            "true_positive": confirmed_tp,
            "false_positive": unsupported_confirmed,
            "precision": _ratio(confirmed_tp, confirmed_tp + unsupported_confirmed),
            "recall": _ratio(confirmed_tp, tp + fn),
        },
        "fuzzy_matching_limited_case_count": sum(
            case["fuzzy_matching_limited"] for case in results
        ),
        "incomplete_case_count": sum(
            case["text_coverage"] != "all_pages_have_text" for case in results
        ),
        "cases": results,
        "warning": (
            "Metrics measure exact page-and-quotation pair alignment only. "
            "Undefined denominators yield null, not 100%. Label quality, issuer "
            "authenticity, and representative real-world accuracy are not established. "
            "OCR-on results depend on installed Tesseract and language packs; "
            "inspect processing warnings and incomplete text coverage."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="Version-1 or version-2 labeled manifest JSON")
    parser.add_argument(
        "--require-pinned-sources", action="store_true",
        help="Reject legacy version-1 manifests without pinned PDF hashes",
    )
    parser.add_argument(
        "--enable-ocr", action="store_true",
        help="Opt into local English/Hindi Tesseract OCR for scanned pages",
    )
    parser.add_argument("--min-precision", type=float, default=None)
    parser.add_argument("--min-recall", type=float, default=None)
    parser.add_argument(
        "--max-unsupported-confirmed", type=int,
        help="Fail when unsupported confirmed pairings exceed this count",
    )
    args = parser.parse_args()
    for threshold in (args.min_precision, args.min_recall):
        if threshold is not None and not 0 <= threshold <= 1:
            parser.error("Thresholds must be between 0 and 1")
    if args.max_unsupported_confirmed is not None and args.max_unsupported_confirmed < 0:
        parser.error("Maximum unsupported confirmed changes must be nonnegative")
    try:
        result = evaluate_labeled(
            args.manifest, enable_ocr=args.enable_ocr,
            require_pinned_sources=args.require_pinned_sources,
        )
    except (OSError, ValueError, ProcessingFailed, ProcessingTimedOut) as exc:
        parser.error(str(exc))
    print(json.dumps(result, indent=2, ensure_ascii=False))
    counts = result["pair_counts"]
    true_positive = counts["true_positive"]
    # Compare thresholds to the raw counts, before presentation rounding.
    for denominator, threshold in (
        (true_positive + counts["false_positive"], args.min_precision),
        (true_positive + counts["false_negative"], args.min_recall),
    ):
        if threshold is not None and (not denominator or true_positive / denominator < threshold):
            return 1
    if (
        args.max_unsupported_confirmed is not None
        and counts["unsupported_confirmed_changes"] > args.max_unsupported_confirmed
    ):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
