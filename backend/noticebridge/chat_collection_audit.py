"""Offline structural audit of collection review packets and native snapshots.

The browser is the reference retrieval implementation. This independent audit
checks exact artifact binding, native fragment references and internal coverage
consistency. It does NOT rerun browser extraction, ranking or answer planning.
Even matching PDF bytes do not prove that the snapshot was extracted from them.
"""

import hashlib
import json
import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn

from .chat_embeddings import EmbeddingError, _decode

MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024
MAX_PACKET_BYTES = 12 * 1024 * 1024
MAX_PDF_BYTES = 10 * 1024 * 1024
MAX_PDF_SET_BYTES = 24 * 1024 * 1024
MAX_DOCUMENTS = 6
MAX_FRAGMENTS = 18000
MAX_SOURCE_FRAGMENTS = 6000
MAX_TEXT_UNITS = 2000000
MAX_SOURCE_UNITS = 800000
MAX_PAGE = 80
MAX_PHYSICAL_PAGES = 1000000
MAX_ORDINAL = 999999
MAX_TURNS = 24
MAX_PARTS = 4
MAX_REVIEWS = 100
SHA = re.compile(r"[0-9a-f]{64}")
SNAPSHOT_POLICY = (
    "Private native text and geometry; not certified transcription or issuer authenticity."
)
NATIVE_POLICY = (
    "Private native extracted text; geometry is a layout hint; not certified PDF transcription."
)
PACKET_POLICY = (
    "Private native excerpts and personal annotations; verify actual PDF pages and "
    "official publication."
)
WORKSPACE_POLICY = (
    "Personal questions and review annotations; replay against exact attached PDF "
    "fingerprints and native text."
)
PLAN_POLICY = (
    "Questions and selected PDF fingerprints only; recompute from attached source bytes."
)
EVIDENCE_POLICY = (
    "Native extracted evidence only; exact replay does not verify meaning, completeness, "
    "applicability or official authority."
)
REVIEW_POLICY = (
    "Personal review annotations bound to native source text; not a certification of "
    "accuracy or authority."
)
STATUSES = ("unreviewed", "reviewed_manually", "needs_followup")
JS_TRIM = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002"
    "\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029"
    "\u202f\u205f\u3000\ufeff"
)


class AuditError(ValueError):
    """Safe fixed-message failure; do not emit private input text or paths."""


def invalid() -> NoReturn:
    raise AuditError("Collection artifact is invalid, inconsistent or exceeds its budget.")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def string(value, limit: int, *, empty: bool = False, trimmed: bool = False) -> str:
    if not isinstance(value, str):
        invalid()
    try:
        units = len(value.encode("utf-16-le")) // 2
    except UnicodeError:
        invalid()
    if units > limit or (not empty and not value.strip(JS_TRIM)):
        invalid()
    if trimmed and value.strip(JS_TRIM) != value:
        invalid()
    return value


def integer(value, low: int, high: int) -> int:
    if type(value) is not int or not low <= value <= high:
        invalid()
    return value


def boolean(value) -> bool:
    if type(value) is not bool:
        invalid()
    return value


def hash_string(value) -> str:
    if not isinstance(value, str) or not SHA.fullmatch(value):
        invalid()
    return value


def obj(value, keys: str) -> dict:
    if not isinstance(value, dict) or set(value) != set(keys.split()):
        invalid()
    return value


def sequence(value, limit: int, *, minimum: int = 0) -> list:
    if not isinstance(value, list) or not minimum <= len(value) <= limit:
        invalid()
    return value


def decode(raw: bytes, limit: int) -> dict:
    try:
        value = _decode(raw, limit)
    except EmbeddingError:
        invalid()
    if not isinstance(value, dict):
        invalid()
    return value


def header(row: dict, format_name: str, policy: str, *, authority: bool = True) -> None:
    if (
        row["format"] != format_name
        or type(row["version"]) is not int
        or row["version"] != 1
        or row["policy"] != policy
        or (authority and row["authority_verified"] is not False)
    ):
        invalid()


def page_list(value, processed: int) -> tuple[int, ...]:
    rows = tuple(integer(page, 1, processed) for page in sequence(value, processed))
    if tuple(sorted(set(rows))) != rows:
        invalid()
    return rows


def finite(value) -> float:
    if type(value) not in (int, float) or abs(value) > 1e9 or not math.isfinite(value):
        invalid()
    return value


@dataclass(frozen=True)
class Fragment:
    page: int
    ordinal: int
    text: str
    position: tuple[float, float, float, float] | None

    @property
    def text_sha256(self) -> str:
        return digest(self.text.encode("utf-8"))


@dataclass(frozen=True)
class NativeSource:
    id: str
    physical_pages: int
    processed_pages: int
    missing: tuple[int, ...]
    limited_pages: tuple[int, ...]
    limited: bool
    fragments: dict[tuple[int, int], Fragment]
    text_units: int

    def coverage(self, page: int | None, *, answer: bool = False) -> str:
        if page is None:
            if self.limited:
                return "partial"
            if not self.fragments:
                return "no_indexed_text"
            return "partial" if self.missing else "some_text"
        if page > self.physical_pages:
            return "not_present"
        if page > self.processed_pages:
            return "not_indexed"
        if page in self.limited_pages:
            return "partial" if answer else "limited"
        if page in self.missing:
            return "no_indexed_text"
        return "some_text"

    def source_at(self, page, ordinal) -> Fragment:
        key = (integer(page, 1, MAX_PAGE), integer(ordinal, 1, MAX_ORDINAL))
        source = self.fragments.get(key)
        if source is None:
            invalid()
        return source

    def inventory(self) -> dict:
        return {
            "document_id": self.id,
            "physical_pages": self.physical_pages,
            "processed_pages": self.processed_pages,
            "missing_pages": list(self.missing),
            "limited_pages": list(self.limited_pages),
            "limited": self.limited,
            "native_fragments": len(self.fragments),
        }


@dataclass(frozen=True)
class Snapshot:
    sha256: str
    sources: dict[str, NativeSource]

    @property
    def ids(self) -> list[str]:
        return list(self.sources)


def parse_fragment(value, processed: int) -> Fragment:
    if not isinstance(value, dict):
        invalid()
    has_position = "position" in value
    keys = "role page ordinal text" + (" position" if has_position else "")
    row = obj(value, keys)
    if row["role"] != "original":
        invalid()
    page = integer(row["page"], 1, processed)
    ordinal = integer(row["ordinal"], 1, MAX_ORDINAL)
    text = string(row["text"], 900, trimmed=True)
    position = None
    if has_position:
        raw = obj(row["position"], "x0 x1 y height")
        position = tuple(finite(raw[key]) for key in ("x0", "x1", "y", "height"))
        if position[1] <= position[0] or position[3] < 1:
            invalid()
    return Fragment(page, ordinal, text, position)


def parse_native_source(value) -> NativeSource:
    outer = obj(value, "format version policy authority_verified sources")
    header(outer, "noticebridge-native-corpus-snapshot", NATIVE_POLICY)
    row = obj(
        sequence(outer["sources"], 1, minimum=1)[0],
        "role sha256 page_count processed_pages missing_pages limited_pages limited passages",
    )
    if row["role"] != "original":
        invalid()
    source_id = hash_string(row["sha256"])
    physical = integer(row["page_count"], 1, MAX_PHYSICAL_PAGES)
    processed = integer(row["processed_pages"], 0, min(physical, MAX_PAGE))
    missing = page_list(row["missing_pages"], processed)
    limited_pages = page_list(row["limited_pages"], processed)
    limited = boolean(row["limited"])
    if not limited and (physical != processed or limited_pages):
        invalid()
    fragments = {}
    present = set()
    units = 0
    previous = (0, 0)
    for raw in sequence(row["passages"], MAX_SOURCE_FRAGMENTS):
        source = parse_fragment(raw, processed)
        key = (source.page, source.ordinal)
        if key <= previous:
            invalid()
        previous = key
        units += len(source.text.encode("utf-16-le")) // 2
        if units > MAX_SOURCE_UNITS:
            invalid()
        fragments[key] = source
        present.add(source.page)
    if tuple(page for page in range(1, processed + 1) if page not in present) != missing:
        invalid()
    return NativeSource(
        source_id, physical, processed, missing, limited_pages, limited, fragments, units,
    )


def parse_snapshot(raw: bytes) -> Snapshot:
    value = obj(
        decode(raw, MAX_SNAPSHOT_BYTES), "format version policy authority_verified sources",
    )
    header(value, "noticebridge-collection-native-snapshot", SNAPSHOT_POLICY)
    sources = {}
    fragments = units = 0
    previous = ""
    for item in sequence(value["sources"], MAX_DOCUMENTS, minimum=1):
        source = parse_native_source(item)
        if source.id <= previous:
            invalid()
        previous = source.id
        sources[source.id] = source
        fragments += len(source.fragments)
        units += source.text_units
    if fragments > MAX_FRAGMENTS or units > MAX_TEXT_UNITS:
        invalid()
    return Snapshot(digest(raw), sources)


def source_set(value, snapshot: Snapshot) -> None:
    if value != snapshot.ids:
        invalid()


def parse_step(value, snapshot: Snapshot) -> dict:
    row = obj(value, "question documentIds includeContext")
    string(row["question"], 400, trimmed=True)
    boolean(row["includeContext"])
    seen = set()
    for source_id in sequence(row["documentIds"], MAX_DOCUMENTS, minimum=1):
        source_id = hash_string(source_id)
        if source_id not in snapshot.sources or source_id in seen:
            invalid()
        seen.add(source_id)
    return row


def parse_plan(value, snapshot: Snapshot) -> list[dict]:
    if value is None:
        return []
    row = obj(value, "format version policy source_ids questions")
    header(row, "noticebridge-collection-question-plan", PLAN_POLICY, authority=False)
    source_set(row["source_ids"], snapshot)
    return [
        parse_step(step, snapshot)
        for step in sequence(row["questions"], MAX_TURNS, minimum=1)
    ]


def parse_reviews(value, snapshot: Snapshot) -> tuple[list[dict], dict]:
    counts = dict.fromkeys(STATUSES, 0)
    if value is None:
        return [], counts
    row = obj(value, "format version policy authority_verified source_ids entries")
    header(row, "noticebridge-collection-native-review", REVIEW_POLICY)
    source_set(row["source_ids"], snapshot)
    seen = set()
    quotes = []
    for raw in sequence(row["entries"], MAX_REVIEWS, minimum=1):
        entry = obj(raw, "document_id page ordinal text_sha256 status note")
        source_id = hash_string(entry["document_id"])
        source = snapshot.sources.get(source_id)
        if source is None:
            invalid()
        fragment = source.source_at(entry["page"], entry["ordinal"])
        key = (source_id, fragment.page, fragment.ordinal)
        if key in seen or hash_string(entry["text_sha256"]) != fragment.text_sha256:
            invalid()
        seen.add(key)
        status = entry["status"]
        if status not in STATUSES:
            invalid()
        note = string(entry["note"], 500, empty=True)
        if any(ord(char) < 32 and char not in "\t\n" or ord(char) == 127 for char in note):
            invalid()
        counts[status] += 1
        quotes.append({
            "document_id": source_id,
            "page": fragment.page,
            "ordinal": fragment.ordinal,
            "native_text": fragment.text,
            "text_sha256": fragment.text_sha256,
            "coverage": source.coverage(fragment.page),
            "status": status,
            "note": note,
        })
    return quotes, counts


def parse_workspace(value, snapshot: Snapshot) -> tuple[list[dict], list[dict], dict]:
    row = obj(
        value,
        "format version policy authority_verified source_ids question_plan evidence_review",
    )
    header(row, "noticebridge-private-collection-workspace", WORKSPACE_POLICY)
    source_set(row["source_ids"], snapshot)
    steps = parse_plan(row["question_plan"], snapshot)
    quotes, counts = parse_reviews(row["evidence_review"], snapshot)
    if not steps and not quotes:
        invalid()
    return steps, quotes, counts


PAGE = re.compile(
    r"\b(?:on|from|in)\s+(?:physical\s+)?(?:pdf\s+)?page\s+([0-9]+)\b",
    re.IGNORECASE | re.ASCII,
)
DIRECTIVE = re.compile(
    r"\b(?:on|from|in)\s+(?:physical\s+)?(?:pdf\s+)?pages?\b",
    re.IGNORECASE | re.ASCII,
)
PAGE_RANGE = re.compile(
    r"^\s*(?:[-–—/,.]\s*\d|(?:to|through|and|or)\s+(?:page\s+)?\d)",
    re.IGNORECASE,
)


def question_page(question: str) -> int | None:
    matches = list(PAGE.finditer(question))
    if len(list(DIRECTIVE.finditer(question))) != len(matches) or len(matches) > 1:
        invalid()
    if not matches:
        return None
    match = matches[0]
    page = int(match.group(1))
    if not 1 <= page <= MAX_PAGE or PAGE_RANGE.search(question[match.end():]):
        invalid()
    return page


def same_flow(left: Fragment, right: Fragment) -> bool:
    # The browser permits adjacent native fragments without geometry.
    # Do not reject a valid packet just because coordinates are unavailable.
    # Structural audit does not reproduce the browser's flow heuristic.
    return left.page == right.page and right.ordinal == left.ordinal + 1


def audit_context(groups, citations: list[Fragment], strict: int, enabled: bool) -> set[int]:
    rows = sequence(groups, 2)
    if rows and (strict or not enabled):
        invalid()
    used = set()
    for raw in rows:
        group = obj(raw, "page citations")
        page = integer(group["page"], 1, MAX_PAGE)
        ids = [integer(item, 1, len(citations))
               for item in sequence(group["citations"], 3, minimum=2)]
        if ids != list(range(len(used) + 1, len(used) + len(ids) + 1)):
            invalid()
        fragments = [citations[item - 1] for item in ids]
        if any(fragment.page != page for fragment in fragments):
            invalid()
        if any(not same_flow(left, right) for left, right in zip(fragments[:-1], fragments[1:], strict=True)):
            invalid()
        if sum(len(fragment.text.encode("utf-16-le")) // 2 for fragment in fragments) > 1400:
            invalid()
        used.update(ids)
    if rows and len(used) != len(citations):
        invalid()
    return used


def audit_printed_fields(value, citations: list[Fragment], context: set[int]) -> int:
    fields = sequence(value, len(citations))
    previous = 0
    for raw in fields:
        row = obj(raw, "citation label value")
        citation = integer(row["citation"], 1, len(citations))
        if citation <= previous or citation in context:
            invalid()
        previous = citation
        source = citations[citation - 1].text
        colon = source.find(":")
        if colon <= 0 or len(source[:colon].encode("utf-16-le")) // 2 > 100:
            invalid()
        label = source[:colon].strip(JS_TRIM)
        text = source[colon + 1:].strip(JS_TRIM)
        if row["label"] != label or row["value"] != text:
            invalid()
        string(text, 300)
    return len(fields)


def audit_part(
    value, source: NativeSource, enabled: bool, counts: Counter,
) -> tuple[str, int | None]:
    part = obj(
        value,
        "question physical_page kind coverage strict_match_count citations "
        "context_groups printed_fields",
    )
    question = string(part["question"], 400, trimmed=True)
    page = part["physical_page"]
    if page is not None:
        integer(page, 1, MAX_PAGE)
    if question_page(question) != page or part["coverage"] != source.coverage(page, answer=True):
        invalid()
    available = sum(1 for fragment in source.fragments.values()
                    if page is None or fragment.page == page)
    strict = integer(part["strict_match_count"], 0, available)
    citations = []
    seen = set()
    for raw in sequence(part["citations"], 6):
        row = obj(raw, "page ordinal text")
        fragment = source.source_at(row["page"], row["ordinal"])
        key = (fragment.page, fragment.ordinal)
        if (key in seen or (page is not None and fragment.page != page)
                or row["text"] != fragment.text):
            invalid()
        seen.add(key)
        citations.append(fragment)
    if part["kind"] != ("passages" if citations else "insufficient"):
        invalid()
    context = audit_context(part["context_groups"], citations, strict, enabled)
    if not context and len(citations) != min(strict, 4):
        invalid()
    printed = audit_printed_fields(part["printed_fields"], citations, context)
    counts["question_parts"] += 1
    counts["citations"] += len(citations)
    counts["printed_fields"] += printed
    counts["context_groups"] += len(part["context_groups"])
    counts["insufficient_parts"] += int(not citations)
    counts["limited_parts"] += int(part["coverage"] != "some_text")
    return question, page


def audit_evidence(value, steps: list[dict], snapshot: Snapshot) -> Counter:
    counts = Counter(dict.fromkeys((
        "question_turns", "question_parts", "citations", "printed_fields",
        "context_groups", "insufficient_parts", "limited_parts",
    ), 0))
    if not steps:
        if value is not None:
            invalid()
        return counts
    row = obj(value, "format version policy authority_verified source_ids questions")
    header(row, "noticebridge-collection-evidence-report", EVIDENCE_POLICY)
    source_set(row["source_ids"], snapshot)
    questions = sequence(row["questions"], MAX_TURNS, minimum=1)
    if len(questions) != len(steps):
        invalid()
    for raw, step in zip(questions, steps, strict=True):
        turn = obj(raw, "step results")
        if parse_step(turn["step"], snapshot) != step:
            invalid()
        results = sequence(turn["results"], MAX_DOCUMENTS, minimum=1)
        if len(results) != len(step["documentIds"]):
            invalid()
        expected_parts = None
        for raw_result, source_id in zip(results, step["documentIds"], strict=True):
            result = obj(raw_result, "document_id parts")
            if result["document_id"] != source_id:
                invalid()
            source = snapshot.sources[source_id]
            parts = [
                audit_part(part, source, step["includeContext"], counts)
                for part in sequence(result["parts"], MAX_PARTS, minimum=1)
            ]
            if expected_parts is not None and expected_parts != parts:
                invalid()
            expected_parts = parts
        counts["question_turns"] += 1
    return counts


def strict_equal(left, right) -> bool:
    """Python True == 1 must never validate a numeric artifact field."""
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(
            strict_equal(left[key], right[key]) for key in left
        )
    if isinstance(left, list):
        return len(left) == len(right) and all(
            strict_equal(a, b) for a, b in zip(left, right, strict=True)
        )
    return left == right


def fingerprint_pdfs(paths: list[Path]) -> dict[str, int]:
    if len(paths) > MAX_DOCUMENTS:
        invalid()
    result = {}
    total = 0
    for path in paths:
        if path.suffix.casefold() != ".pdf" or path.is_symlink() or not path.is_file():
            invalid()
        hasher = hashlib.sha256()
        size = 0
        with path.open("rb") as stream:
            while chunk := stream.read(65536):
                size += len(chunk)
                total += len(chunk)
                if size > MAX_PDF_BYTES or total > MAX_PDF_SET_BYTES:
                    invalid()
                hasher.update(chunk)
        fingerprint = hasher.hexdigest()
        if not size or fingerprint in result:
            invalid()
        result[fingerprint] = size
    return result


def audit_packet(
    packet_raw: bytes, snapshot_raw: bytes, pdf_paths: list[Path] | None = None,
) -> dict:
    snapshot = parse_snapshot(snapshot_raw)
    row = obj(
        decode(packet_raw, MAX_PACKET_BYTES),
        "format version policy authority_verified snapshot_sha256 workspace evidence_report "
        "sources review_counts review_quotes",
    )
    header(row, "noticebridge-collection-review-packet", PACKET_POLICY)
    if hash_string(row["snapshot_sha256"]) != snapshot.sha256:
        invalid()
    inventory = [source.inventory() for source in snapshot.sources.values()]
    if not strict_equal(row["sources"], inventory):
        invalid()
    steps, quotes, review_counts = parse_workspace(row["workspace"], snapshot)
    if not strict_equal(row["review_quotes"], quotes):
        invalid()
    if not strict_equal(row["review_counts"], review_counts):
        invalid()
    counts = audit_evidence(row["evidence_report"], steps, snapshot)
    fingerprints = fingerprint_pdfs(pdf_paths) if pdf_paths is not None else None
    missing = [] if fingerprints is None else sorted(set(snapshot.ids) - fingerprints.keys())
    unexpected = [] if fingerprints is None else sorted(fingerprints.keys() - set(snapshot.ids))
    return {
        "format": "noticebridge-collection-packet-structural-audit",
        "version": 1,
        "policy": "Structural and source-reference consistency only; no retrieval replay.",
        "authority_verified": False,
        "answer_accuracy_verified": False,
        "retrieval_replayed": False,
        "native_extraction_replayed": False,
        "canonical_browser_encoding_verified": False,
        "packet_sha256": digest(packet_raw),
        "snapshot_sha256": snapshot.sha256,
        "snapshot_references_consistent": True,
        "pdf_bytes_checked": fingerprints is not None,
        "pdf_byte_set_matches": None if fingerprints is None else not missing and not unexpected,
        "missing_pdf_ids": missing,
        "unexpected_pdf_ids": unexpected,
        "sources": [
            {"document_id": source_id, "pdf_bytes": fingerprints.get(source_id)
             if fingerprints is not None else None}
            for source_id in snapshot.ids
        ],
        "counts": {
            "documents": len(snapshot.sources),
            "native_fragments": sum(len(source.fragments) for source in snapshot.sources.values()),
            "review_annotations": len(quotes),
            **counts,
        },
    }


def encode_audit(report: dict) -> bytes:
    return (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
