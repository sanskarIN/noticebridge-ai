"""Independent snapshot difference recomputation.

Only supplied snapshot bytes are checked. No PDF is reopened, no text is
included in the audit output, and no official amendment is inferred.
"""

from .chat_collection_audit import (
    Fragment,
    NativeSource,
    Snapshot,
    decode,
    digest,
    invalid,
    parse_snapshot,
    strict_equal,
)

MAX_DIFFERENCE_BYTES = 6 * 1024 * 1024
KINDS = ("identical", "text", "geometry", "text_and_geometry", "left_only", "right_only")


def empty_counts() -> dict[str, int]:
    return dict.fromkeys(KINDS, 0)


def classify(left: Fragment | None, right: Fragment | None) -> str:
    if left is None:
        return "right_only"
    if right is None:
        return "left_only"
    text = left.text == right.text
    geometry = left.position == right.position
    if text:
        return "identical" if geometry else "geometry"
    return "text" if geometry else "text_and_geometry"


def coverage(left: NativeSource, right: NativeSource) -> dict:
    return {
        "expected_physical_pages": left.physical_pages,
        "observed_physical_pages": right.physical_pages,
        "expected_processed_pages": left.processed_pages,
        "observed_processed_pages": right.processed_pages,
        "expected_limited": left.limited,
        "observed_limited": right.limited,
        "expected_missing_pages": list(left.missing),
        "observed_missing_pages": list(right.missing),
        "expected_limited_pages": list(left.limited_pages),
        "observed_limited_pages": list(right.limited_pages),
        "matches": (
            left.physical_pages == right.physical_pages
            and left.processed_pages == right.processed_pages
            and left.limited == right.limited
            and left.missing == right.missing
            and left.limited_pages == right.limited_pages
        ),
    }


def source_difference(
    source_id: str, left: NativeSource | None, right: NativeSource | None,
) -> dict:
    if left is None and right is None:
        invalid()
    a = left.fragments if left else {}
    b = right.fragments if right else {}
    coordinates = sorted(a.keys() | b.keys())
    counts = empty_counts()
    pages: dict[int, dict[str, int]] = {}
    changed = []
    for page, ordinal in coordinates:
        key = (page, ordinal)
        kind = classify(a.get(key), b.get(key))
        counts[kind] += 1
        pages.setdefault(page, empty_counts())[kind] += 1
        if kind != "identical":
            changed.append({"page": page, "ordinal": ordinal, "kind": kind})
    metadata = coverage(left, right) if left is not None and right is not None else None
    if left is None:
        status = "right_only"
    elif right is None:
        status = "left_only"
    elif metadata["matches"] and not changed:
        status = "identical"
    else:
        status = "different"
    return {
        "id": source_id,
        "status": status,
        "coverage": metadata,
        "left_fragments": len(a),
        "right_fragments": len(b),
        "counts": counts,
        "pages": [{"page": page, "counts": count} for page, count in pages.items()],
        "changed_coordinates": changed,
    }


def recompute_difference(left: Snapshot, right: Snapshot) -> dict:
    ids = sorted(left.sources.keys() | right.sources.keys())
    sources = [
        source_difference(source_id, left.sources.get(source_id), right.sources.get(source_id))
        for source_id in ids
    ]
    counts = empty_counts()
    for source in sources:
        for kind in KINDS:
            counts[kind] += source["counts"][kind]
    return {
        "format": "noticebridge-collection-snapshot-difference",
        "version": 1,
        "authority_verified": False,
        "pdf_bytes_verified": False,
        "extraction_completeness_verified": False,
        "left_sha256": left.sha256,
        "right_sha256": right.sha256,
        "same_fingerprint_set": left.ids == right.ids,
        "exact_snapshot_match": left.sha256 == right.sha256,
        "counts": counts,
        "sources": sources,
    }


def audit_difference(report_raw: bytes, left_raw: bytes, right_raw: bytes) -> dict:
    left = parse_snapshot(left_raw)
    right = parse_snapshot(right_raw)
    expected = recompute_difference(left, right)
    # Compare actual bytes for this field rather than relying solely on hashes.
    expected["exact_snapshot_match"] = left_raw == right_raw
    candidate = decode(report_raw, MAX_DIFFERENCE_BYTES)
    if not strict_equal(candidate, expected):
        invalid()
    return {
        "format": "noticebridge-collection-snapshot-difference-audit",
        "version": 1,
        "policy": "Independent recomputation on supplied native snapshot artifacts only.",
        "authority_verified": False,
        "pdf_bytes_verified": False,
        "native_extraction_replayed": False,
        "extraction_completeness_verified": False,
        "canonical_browser_encoding_verified": False,
        "difference_recomputed": True,
        "report_sha256": digest(report_raw),
        "left_sha256": left.sha256,
        "right_sha256": right.sha256,
        "same_fingerprint_set": expected["same_fingerprint_set"],
        "exact_snapshot_match": expected["exact_snapshot_match"],
        "sources": len(expected["sources"]),
        "counts": expected["counts"],
    }
