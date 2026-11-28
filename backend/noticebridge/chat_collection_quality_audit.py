"""Independent native-quality diagnostic replay from a collection snapshot.

Unicode categories are supplied by the installed Python Unicode database.
If browser and Python category assignments differ, the exact comparison
fails; it never silently asserts agreement across Unicode versions.
"""
import unicodedata
from collections import Counter, defaultdict

from .chat_collection_audit import (
    MAX_DOCUMENTS,
    NativeSource,
    Snapshot,
    decode,
    digest,
    hash_string,
    header,
    invalid,
    obj,
    parse_snapshot,
    sequence,
    strict_equal,
)

MAX_QUALITY_BYTES = 6 * 1024 * 1024
FORMAT = "noticebridge-collection-native-quality"
POLICY = (
    "Native extraction cues only; not OCR confidence, reading-order certification or completeness."
)
FLAGS = (
    "replacement",
    "private_use",
    "control",
    "no_letters_or_digits",
    "missing_geometry",
    "duplicate_on_page",
    "repeated_across_pages",
)


def empty_counts() -> dict[str, int]:
    return dict.fromkeys(FLAGS, 0)


def utf16_units(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def character_flags(text: str) -> list[str]:
    categories = tuple(unicodedata.category(char) for char in text)
    result = []
    if "\ufffd" in text:
        result.append("replacement")
    if "Co" in categories:
        result.append("private_use")
    if any(
        kind in ("Cc", "Cf") and char not in "\t\n\r"
        for char, kind in zip(text, categories, strict=True)
    ):
        result.append("control")
    if not any(kind.startswith(("L", "N")) for kind in categories):
        result.append("no_letters_or_digits")
    return result


def analyze_source(source: NativeSource) -> dict:
    by_page = defaultdict(list)
    text_pages = defaultdict(set)
    for fragment in source.fragments.values():
        by_page[fragment.page].append(fragment)
        text_pages[fragment.text].add(fragment.page)
    counts = empty_counts()
    flagged_fragments = 0
    characters = 0
    pages = []
    # Only processed pages are enumerated. Physical page counts can be
    # substantially larger and cannot induce unbounded allocations.
    for page in range(1, source.processed_pages + 1):
        fragments = by_page[page]
        frequencies = Counter(fragment.text for fragment in fragments)
        local = empty_counts()
        flagged = []
        units = 0
        for fragment in fragments:
            units += utf16_units(fragment.text)
            flags = character_flags(fragment.text)
            if fragment.position is None:
                flags.append("missing_geometry")
            if frequencies[fragment.text] > 1:
                flags.append("duplicate_on_page")
            if len(text_pages[fragment.text]) > 1:
                flags.append("repeated_across_pages")
            for flag in flags:
                local[flag] += 1
            if flags:
                flagged.append({"ordinal": fragment.ordinal, "flags": flags})
        for flag in FLAGS:
            counts[flag] += local[flag]
        flagged_fragments += len(flagged)
        characters += units
        pages.append({
            "page": page,
            "coverage": source.coverage(page),
            "fragments": len(fragments),
            "characters": units,
            "counts": local,
            "flagged": flagged,
        })
    return {
        "id": source.id,
        "physical_pages": source.physical_pages,
        "processed_pages": source.processed_pages,
        "unprocessed_pages": source.physical_pages - source.processed_pages,
        "limited": source.limited,
        "fragments": len(source.fragments),
        "characters": characters,
        "flagged_fragments": flagged_fragments,
        "counts": counts,
        "pages": pages,
    }


def recompute_quality(snapshot: Snapshot, selection: list[str]) -> dict:
    ids = [
        hash_string(value)
        for value in sequence(selection, MAX_DOCUMENTS, minimum=1)
    ]
    if len(set(ids)) != len(ids) or any(key not in snapshot.sources for key in ids):
        invalid()
    sources = [analyze_source(snapshot.sources[key]) for key in ids]
    counts = {
        flag: sum(source["counts"][flag] for source in sources)
        for flag in FLAGS
    }
    return {
        "format": FORMAT,
        "version": 1,
        "policy": POLICY,
        "authority_verified": False,
        "extraction_completeness_verified": False,
        "pdf_bytes_verified": False,
        "snapshot_sha256": snapshot.sha256,
        "source_ids": ids,
        "fragments": sum(source["fragments"] for source in sources),
        "characters": sum(source["characters"] for source in sources),
        "flagged_fragments": sum(source["flagged_fragments"] for source in sources),
        "counts": counts,
        "sources": sources,
    }


def audit_quality(report_raw: bytes, snapshot_raw: bytes) -> dict:
    snapshot = parse_snapshot(snapshot_raw)
    candidate = obj(
        decode(report_raw, MAX_QUALITY_BYTES),
        "format version policy authority_verified extraction_completeness_verified "
        "pdf_bytes_verified snapshot_sha256 source_ids fragments characters "
        "flagged_fragments counts sources",
    )
    header(candidate, FORMAT, POLICY)
    expected = recompute_quality(snapshot, candidate["source_ids"])
    if not strict_equal(candidate, expected):
        invalid()
    return {
        "format": "noticebridge-collection-native-quality-audit",
        "version": 1,
        "policy": "Independent Unicode-category and exact duplicate diagnostic replay.",
        "authority_verified": False,
        "native_extraction_replayed": False,
        "pdf_bytes_verified": False,
        "extraction_completeness_verified": False,
        "canonical_browser_encoding_verified": False,
        "diagnostics_recomputed": True,
        "unicode_database_version": unicodedata.unidata_version,
        "report_sha256": digest(report_raw),
        "snapshot_sha256": snapshot.sha256,
        "source_ids": expected["source_ids"],
        "fragments": expected["fragments"],
        "characters": expected["characters"],
        "flagged_fragments": expected["flagged_fragments"],
        "counts": expected["counts"],
    }
