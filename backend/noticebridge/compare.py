"""Conservative deterministic PDF comparison. No AI inference masquerading as verification."""

import re
import unicodedata
from collections import defaultdict, deque
from difflib import SequenceMatcher

from .extract import ExtractedDocument
from .models import ChecklistItem, ComparisonReport, Finding

# Match full Western dates; not bare numbers. Multilingual date normalization is future work.
DATE = re.compile(
    r"\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{4}|"
    r"\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|"
    r"Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|"
    r"Nov(?:ember)?|Dec(?:ember)?)\s+\d{4})\b",
    re.IGNORECASE,
)
AMOUNT = re.compile(r"(?<!\w)(?:₹|Rs\.?\s*)\d[\d,]*(?:\.\d+)?", re.IGNORECASE)
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
    value = DATE.sub(" [date] ", value)
    value = AMOUNT.sub(" [amount] ", value)
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
    unmatched = set(range(len(new.lines)))
    match_for_old: dict[int, tuple[int, float]] = {}
    exact: dict[tuple[str, str], deque[int]] = defaultdict(deque)
    # A bounded token index avoids quadratic comparisons on long official PDFs.
    by_token: dict[tuple[str, str], list[int]] = defaultdict(list)
    for ni, line in enumerate(new.lines):
        key = (category_for(line.text), anchor(line.text))
        exact[key].append(ni)
        for token in set(re.findall(r"[\w\u0900-\u097f]{4,}", key[1])):
            by_token[(key[0], token)].append(ni)

    for oi, original in enumerate(old.lines):
        category = category_for(original.text)
        key = (category, anchor(original.text))
        candidates = exact[key]
        while candidates and candidates[0] not in unmatched:
            candidates.popleft()
        if candidates:
            ni = candidates.popleft()
            match_for_old[oi] = (ni, 1.0)
            unmatched.remove(ni)
            continue
        seen: set[int] = set()
        for token in set(re.findall(r"[\w\u0900-\u097f]{4,}", key[1])):
            seen.update(by_token.get((category, token), [])[:120])
        ranked = sorted(
            ((_score(original.text, new.lines[ni].text), ni) for ni in seen if ni in unmatched),
            key=lambda item: (-item[0], item[1]),
        )
        if ranked and ranked[0][0] >= 0.66:
            score, ni = ranked[0]
            match_for_old[oi] = (ni, score)
            unmatched.remove(ni)

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
        ni, score = match_for_old[oi]
        revised = new.lines[ni]
        if normalize(original.text) == normalize(revised.text):
            continue
        strong = score >= 0.85
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
            )
        )

    for ni in sorted(unmatched):
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

    # A contradiction is emitted only for two different complete deadline dates
    # with the same labeled context inside ONE document, never solely because
    # the user uploaded one document after another.
    for document in (old, new):
        grouped: dict[str, list[tuple[str, object]]] = defaultdict(list)
        for line in document.lines:
            if category_for(line.text) != "deadline":
                continue
            dates = DATE.findall(line.text)
            if len(dates) == 1:
                grouped[anchor(line.text)].append((normalize(dates[0]), line.evidence))
        for _, records in grouped.items():
            if len(set(date for date, _ in records)) < 2:
                continue
            first = records[0]
            for other in records[1:]:
                if other[0] == first[0]:
                    continue
                findings.append(Finding(
                    id=f"f{len(findings)+1}",
                    status="contradiction",
                    category="deadline",
                    summary_en=(
                        "Conflicting deadline dates occur under the same label within one PDF."
                    ),
                    summary_hi=(
                        "एक ही PDF में समान शीर्षक के अंतर्गत "
                        "अलग-अलग अंतिम तिथियाँ मिली हैं।"
                    ),
                    supporting_evidence=[first[1], other[1]],
                    similarity=1.0,
                ))
                break

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
