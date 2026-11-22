"""Conservative deterministic PDF comparison. No AI inference masquerading as verification."""

import re
import unicodedata
from collections import Counter, defaultdict, deque
from difflib import SequenceMatcher

from .extract import ExtractedDocument
from .facts import AMOUNT_TOKEN, DATE_TOKEN, date_tokens, field_changes
from .models import ChecklistItem, ComparisonReport, Finding

NUMBER = re.compile(r"\b\d+(?:[.:]\d+)?\b")
SPACE = re.compile(r"\s+")

CATEGORIES = (
    (
        "deadline",
        (
            "deadline", "last date", "closing date", "due date", "apply by",
            "अंतिम तिथि", "अंतिम तारीख",
        ),
    ),
    ("eligibility", ("eligib", "qualification", "required degree", "पात्रता", "योग्यता")),
    ("fee", ("application fee", "fee", "payment", "शुल्क", "फीस")),
    ("time", ("exam time", "reporting time", "time of", "समय")),
    ("instruction", ("must", "submit", "required", "instruction", "अनिवार्य", "जमा करें")),
)


def normalize(value: str) -> str:
    return SPACE.sub(" ", unicodedata.normalize("NFKC", value).casefold()).strip()


def category_for(text: str) -> str:
    value = normalize(text)
    for category, terms in CATEGORIES:
        if any(term in value for term in terms):
            return category
    return "general"


def anchor(text: str) -> str:
    """Suppress changed dates/amounts/numerals when comparing statement context."""
    value = normalize(text)
    value = DATE_TOKEN.sub(" [date] ", value)
    value = AMOUNT_TOKEN.sub(" [amount] ", value)
    value = NUMBER.sub(" [number] ", value)
    return SPACE.sub(" ", value).strip()


def _score(old: str, new: str) -> float:
    return SequenceMatcher(None, anchor(old), anchor(new), autojunk=False).ratio()


def compare_documents(old: ExtractedDocument, new: ExtractedDocument) -> ComparisonReport:
    """Align by contextual similarity, then report exact text deltas with both source locations.

    This algorithm is intentionally conservative; order is NOT evidence of authority.
    """
    findings: list[Finding] = []
    checklist: list[ChecklistItem] = []
    warnings = [*old.warnings, *new.warnings]
    if not old.lines or not new.lines:
        warnings.append("At least one document has no extractable text; comparison is incomplete")
    # Pass one: preserve identical statements regardless of order. Doing this
    # before masking dates prevents reordered duplicate deadline headings from
    # producing spurious change reports.
    unmatched_old = set(range(len(old.lines)))
    unmatched_new = set(range(len(new.lines)))
    match_for_old: dict[int, tuple[int, float, bool]] = {}
    exact_text: dict[str, deque[int]] = defaultdict(deque)
    for ni, line in enumerate(new.lines):
        exact_text[normalize(line.text)].append(ni)
    for oi, line in enumerate(old.lines):
        possible = exact_text[normalize(line.text)]
        if possible:
            ni = possible.popleft()
            match_for_old[oi] = (ni, 1.0, False)
            unmatched_old.remove(oi)
            unmatched_new.remove(ni)

    # Pass two: use matching labels with masked values, but explicitly mark
    # duplicates as ambiguous. Repeated "Deadline" rows can mean different
    # events and their relationship is not inferable from their position.
    old_keys = [(category_for(line.text), anchor(line.text)) for line in old.lines]
    new_keys = [(category_for(line.text), anchor(line.text)) for line in new.lines]
    old_counts = Counter(old_keys)
    new_counts = Counter(new_keys)
    anchored: dict[tuple[str, str], deque[int]] = defaultdict(deque)
    for ni in sorted(unmatched_new):
        anchored[new_keys[ni]].append(ni)
    for oi in sorted(unmatched_old):
        key = old_keys[oi]
        if not anchored[key]:
            continue
        ni = anchored[key].popleft()
        ambiguous = old_counts[key] > 1 or new_counts[key] > 1
        match_for_old[oi] = (ni, 1.0, ambiguous)
        unmatched_new.remove(ni)
    unmatched_old.difference_update(match_for_old)

    # Pass three: global best-first fuzzy assignment instead of greedy old-line
    # ordering. Token posting lists cap candidate work for large documents.
    by_token: dict[tuple[str, str], list[int]] = defaultdict(list)
    for ni in sorted(unmatched_new):
        category, text = new_keys[ni]
        for token in set(re.findall(r"[\w\u0900-\u097f]{4,}", text)):
            by_token[(category, token)].append(ni)
    proposals: list[tuple[float, int, int]] = []
    scores_by_old: dict[int, list[float]] = defaultdict(list)
    scores_by_new: dict[int, list[float]] = defaultdict(list)
    for oi in sorted(unmatched_old):
        category, text = old_keys[oi]
        candidates: set[int] = set()
        for token in sorted(set(re.findall(r"[\w\u0900-\u097f]{4,}", text))):
            candidates.update(by_token.get((category, token), [])[:120])
        for ni in sorted(candidates):
            score = _score(old.lines[oi].text, new.lines[ni].text)
            if score >= 0.66:
                proposals.append((score, oi, ni))
                scores_by_old[oi].append(score)
                scores_by_new[ni].append(score)
    for score, oi, ni in sorted(proposals, key=lambda p: (-p[0], p[1], p[2])):
        if oi not in unmatched_old or ni not in unmatched_new:
            continue
        scores_o = sorted(scores_by_old[oi], reverse=True)
        scores_n = sorted(scores_by_new[ni], reverse=True)
        ambiguous = (
            (len(scores_o) > 1 and scores_o[0] - scores_o[1] < 0.05)
            or (len(scores_n) > 1 and scores_n[0] - scores_n[1] < 0.05)
        )
        match_for_old[oi] = (ni, score, ambiguous)
        unmatched_old.remove(oi)
        unmatched_new.remove(ni)

    for oi, original in enumerate(old.lines):
        if oi not in match_for_old:
            # Missing line is not automatically a canceled requirement.
            findings.append(
                Finding(
                    id=f"f{len(findings)+1}",
                    status="missing_information",
                    category=category_for(original.text),
                    summary_en="Statement present only in original; removal is not verified.",
                    summary_hi="यह कथन केवल मूल दस्तावेज़ में मिला; हटाया जाना प्रमाणित नहीं है।",
                    original=original.evidence,
                    similarity=0,
                )
            )
            continue
        ni, score, ambiguous = match_for_old[oi]
        revised = new.lines[ni]
        if normalize(original.text) == normalize(revised.text):
            continue
        strong = score >= 0.85 and not ambiguous
        status = "confirmed_change" if strong else "possible_change"
        findings.append(
            Finding(
                id=f"f{len(findings)+1}",
                status=status,
                category=category_for(original.text),
                summary_en=(
                    "Document wording differs at matched source passages. "
                    "Authority is not verified."
                    if strong else "Possibly related passages differ; check the source context."
                ),
                summary_hi=(
                    "संबंधित स्रोत अंशों के शब्द अलग हैं; आधिकारिक प्राथमिकता सत्यापित नहीं है।"
                    if strong else "संभवतः संबंधित अंश अलग हैं; स्रोत का संदर्भ जाँचें।"
                ),
                original=original.evidence,
                revised=revised.evidence,
                similarity=round(score, 3),
                field_changes=field_changes(
                    original.text, revised.text, category=category_for(original.text)
                ),
            )
        )

    for ni in sorted(unmatched_new):
        revised = new.lines[ni]
        findings.append(
            Finding(
                id=f"f{len(findings)+1}",
                status="missing_information",
                category=category_for(revised.text),
                summary_en=(
                    "Statement present only in revised document; "
                    "addition is not independently verified."
                ),
                summary_hi=(
                    "यह कथन केवल संशोधित दस्तावेज़ में मिला; "
                    "जोड़ की स्वतंत्र पुष्टि नहीं है।"
                ),
                revised=revised.evidence,
                similarity=0,
            )
        )

    # Only unambiguous, calendar-valid conflicting dates within the same
    # document and labeled context are contradictions. Ambiguous 01/02/2026 is
    # never treated as a verified different date from 02/01/2026.
    for document in (old, new):
        grouped: dict[str, list[tuple[str, object]]] = defaultdict(list)
        for line in document.lines:
            if category_for(line.text) != "deadline":
                continue
            dates = date_tokens(line.text)
            if len(dates) == 1 and dates[0].canonical is not None:
                grouped[anchor(line.text)].append((dates[0].canonical, line.evidence))
        for records in grouped.values():
            if len({value for value, _ in records}) < 2:
                continue
            first_value, first_evidence = records[0]
            different = next((ev for value, ev in records if value != first_value), None)
            if different is None:
                continue
            findings.append(Finding(
                id=f"f{len(findings)+1}",
                status="contradiction",
                category="deadline",
                summary_en="Conflicting calendar dates appear under one label in the same PDF.",
                summary_hi="एक ही PDF में समान शीर्षक के अंतर्गत अलग-अलग तिथियाँ मिली हैं।",
                supporting_evidence=[first_evidence, different],
                similarity=1.0,
            ))

    for finding in findings:
        if finding.category in {"deadline", "eligibility", "fee", "time", "instruction"}:
            checklist.append(
                ChecklistItem(
                    description_en=(
                        f"Verify the {finding.category} statement with the official issuer."
                    ),
                    description_hi=(
                        "जारीकर्ता के आधिकारिक स्रोत से "
                        f"{finding.category} संबंधी कथन की पुष्टि करें।"
                    ),
                    finding_id=finding.id,
                )
            )
    return ComparisonReport(
        documents=[old.summary, new.summary],
        findings=findings,
        checklist=checklist,
        warnings=warnings,
    )
