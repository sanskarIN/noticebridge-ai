"""Conservative deterministic PDF comparison. No AI inference masquerading as verification."""

import re
import unicodedata
from collections import Counter, defaultdict, deque

from .amendments import (
    AmendmentKey,
    Statement,
    linked_amendment,
    original_statement,
    revised_amendment,
)
from .extract import ExtractedDocument
from .facts import (
    AMOUNT_TOKEN,
    DATE_TOKEN,
    WORD_CHAR,
    date_tokens,
    field_changes,
    single_clock_token,
)
from .matching import StatementKey, fuzzy_proposals
from .messages import SUMMARY_MESSAGES, review_messages
from .models import ChecklistItem, ComparisonReport, Evidence, Finding, ValueChange
from .warning_policy import MAX_CROSS_PAGE_DETAILS

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
    (
        "eligibility",
        ("eligib", "ineligib", "qualification", "required degree", "पात्रता", "योग्यता"),
    ),
    ("fee", ("application fee", "fees", "fee", "payment", "शुल्क", "फीस")),
    ("time", ("exam time", "reporting time", "interview time", "time of", "समय")),
    ("instruction", ("must", "submit", "required", "instruction", "अनिवार्य", "जमा करें")),
)


def normalize(value: str) -> str:
    return SPACE.sub(" ", unicodedata.normalize("NFKC", value).casefold()).strip()


# A raw substring test would classify "coffee" as a fee or "repayment" as payment evidence.
CATEGORY_MATCHERS = tuple(
    (
        category,
        tuple(
            re.compile(
                rf"(?<!{WORD_CHAR}){re.escape(term)}"
                + (
                    rf"{WORD_CHAR}*"
                    if term in {"eligib", "ineligib"}
                    else rf"(?!{WORD_CHAR})"
                )
            )
            for term in terms
        ),
    )
    for category, terms in CATEGORIES
)


def category_for(text: str) -> str:
    value = normalize(text)
    for category, expressions in CATEGORY_MATCHERS:
        if any(expression.search(value) for expression in expressions):
            return category
    return "general"


def anchor(text: str, category: str, *, mask_clock: bool = True) -> str:
    """Mask expected values while keeping dates of scheduled events and other scope."""
    if mask_clock and category in ("deadline", "time"):
        clock = single_clock_token(text)
        if clock is not None:
            text = text[:clock.start()] + " [time] " + text[clock.end():]
    value = normalize(text)
    if category == "deadline":
        value = DATE_TOKEN.sub(" [date] ", value)
    elif category == "fee":
        value = AMOUNT_TOKEN.sub(" [amount] ", value)
    elif category != "time":
        value = DATE_TOKEN.sub(" [date] ", value)
        value = AMOUNT_TOKEN.sub(" [amount] ", value)
        value = NUMBER.sub(" [number] ", value)
    return SPACE.sub(" ", value).strip()


def _statement_key(text: str) -> StatementKey:
    category = category_for(text)
    return category, anchor(text, category)


def _link_amendments(
    old: ExtractedDocument,
    new: ExtractedDocument,
    old_keys: list[StatementKey],
    new_keys: list[StatementKey],
    unmatched_old: set[int],
    unmatched_new: set[int],
) -> dict[int, tuple[int, ValueChange]]:
    amendments: dict[AmendmentKey, list[tuple[int, Statement]]] = defaultdict(list)
    for index, line in enumerate(new.lines):
        if " from " not in normalize(line.text):
            continue
        statement = revised_amendment(line.text, new_keys[index][0])
        if statement is not None:
            amendments[statement.key].append((index, statement))
    if not amendments:
        return {}
    originals: dict[AmendmentKey, list[tuple[int, Statement]]] = defaultdict(list)
    for index, line in enumerate(old.lines):
        statement = original_statement(line.text, old_keys[index][0])
        if statement is not None and statement.key in amendments:
            originals[statement.key].append((index, statement))
    result = {}
    for key, candidates in originals.items():
        if len(candidates) == len(amendments[key]) == 1:
            (oi, original), (ni, amendment) = candidates[0], amendments[key][0]
            if oi in unmatched_old and ni in unmatched_new:
                result[oi] = ni, linked_amendment(original, amendment)
                unmatched_old.remove(oi)
                unmatched_new.remove(ni)
    return result


def compare_documents(old: ExtractedDocument, new: ExtractedDocument) -> ComparisonReport:
    """Align by contextual similarity, then report exact text deltas with both source locations.

    This algorithm is intentionally conservative; order is NOT evidence of authority.
    """
    findings: list[Finding] = []
    checklist: list[ChecklistItem] = []
    warnings = [*old.warnings, *new.warnings]
    if not old.lines or not new.lines:
        coverage = "inconclusive"
        warnings.append("At least one document has no extractable text; comparison is incomplete")
    elif old.summary.pages_without_text or new.summary.pages_without_text:
        coverage = "partial"
        warnings.append(
            "Some pages have no extractable text; comparisons may omit changes on those pages"
        )
    else:
        coverage = "all_pages_have_text"
    # Pass one: preserve identical statements regardless of order. Doing this
    # before masking dates prevents reordered duplicate deadline headings from
    # producing spurious change reports.
    unmatched_old = set(range(len(old.lines)))
    unmatched_new = set(range(len(new.lines)))
    # Each entry carries the revised index, similarity, and whether a unique
    # exact context anchor supports the pairing.
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
    old_keys = [_statement_key(line.text) for line in old.lines]
    new_keys = [_statement_key(line.text) for line in new.lines]
    amendments = _link_amendments(old, new, old_keys, new_keys, unmatched_old, unmatched_new)
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
        unique_context = old_counts[key] == new_counts[key] == 1
        match_for_old[oi] = (ni, 1.0, unique_context)
        unmatched_new.remove(ni)
    unmatched_old.difference_update(match_for_old)

    # Pass three: global best-first fuzzy assignment instead of greedy old-line
    # ordering. Token posting lists cap candidate work for large documents.
    proposals, fuzzy_matching_limited = fuzzy_proposals(
        old_keys, new_keys, unmatched_old, unmatched_new,
    )
    for score, oi, ni in sorted(proposals, key=lambda p: (-p[0], p[1], p[2])):
        if oi not in unmatched_old or ni not in unmatched_new:
            continue
        match_for_old[oi] = (ni, score, False)
        unmatched_old.remove(oi)
        unmatched_new.remove(ni)

    for oi, original in enumerate(old.lines):
        category = old_keys[oi][0]
        if oi in amendments:
            ni, change = amendments[oi]
            summary_en, summary_hi = SUMMARY_MESSAGES["explicit_amendment"]
            findings.append(Finding(
                id=f"f{len(findings)+1}", status="possible_change", category=category,
                summary_en=summary_en, summary_hi=summary_hi, original=original.evidence,
                revised=new.lines[ni].evidence, similarity=0, match_method="explicit_amendment",
                field_changes=[change],
            ))
            continue
        if oi not in match_for_old:
            # Missing line is not automatically a canceled requirement.
            findings.append(
                Finding(
                    id=f"f{len(findings)+1}",
                    status="missing_information",
                    category=category,
                    summary_en=SUMMARY_MESSAGES["missing_original"][0],
                    summary_hi=SUMMARY_MESSAGES["missing_original"][1],
                    original=original.evidence,
                    similarity=0,
                )
            )
            continue
        ni, score, unique_context = match_for_old[oi]
        revised = new.lines[ni]
        if normalize(original.text) == normalize(revised.text):
            continue
        # Similar wording can concern different requirements. Only native
        # text with a unique exact context anchor can support confirmation.
        strong = (
            unique_context
            and original.evidence.extraction_method == "native"
            and revised.evidence.extraction_method == "native"
        )
        status = "confirmed_change" if strong else "possible_change"
        findings.append(
            Finding(
                id=f"f{len(findings)+1}",
                status=status,
                category=category,
                summary_en=SUMMARY_MESSAGES[status][0],
                summary_hi=SUMMARY_MESSAGES[status][1],
                original=original.evidence,
                revised=revised.evidence,
                similarity=round(score, 3),
                field_changes=field_changes(
                    original.text, revised.text, category=category, pairing_confirmed=strong,
                ),
            )
        )

    for ni in sorted(unmatched_new):
        revised = new.lines[ni]
        findings.append(
            Finding(
                id=f"f{len(findings)+1}",
                status="missing_information",
                category=new_keys[ni][0],
                summary_en=SUMMARY_MESSAGES["missing_revised"][0],
                summary_hi=SUMMARY_MESSAGES["missing_revised"][1],
                revised=revised.evidence,
                similarity=0,
            )
        )

    # A generic deadline heading can recur for different requirements on
    # different pages (e.g., application and late-fee phases). Only same-page
    # duplicate labels with conflicting unambiguous calendar dates are marked
    # contradictions. Cross-page differences remain explicit review warnings.
    for document, keys in ((old, old_keys), (new, new_keys)):
        grouped: dict[str, list[tuple[str, Evidence]]] = defaultdict(list)
        cross_page_warnings = 0
        for line, (category, _) in zip(document.lines, keys, strict=True):
            if (
                category != "deadline"
                or line.evidence.extraction_method != "native"
            ):
                continue
            dates = date_tokens(line.text)
            if len(dates) == 1 and dates[0].canonical is not None:
                # Keep clock labels distinct for the existing calendar-date conflict rule.
                context = anchor(line.text, "deadline", mask_clock=False)
                grouped[context].append((dates[0].canonical, line.evidence))
        for records in grouped.values():
            if len({value for value, _ in records}) < 2:
                continue
            by_page: dict[int, list[tuple[str, Evidence]]] = defaultdict(list)
            for value, evidence in records:
                by_page[evidence.page].append((value, evidence))
            has_same_page_conflict = False
            for page_records in by_page.values():
                if len({value for value, _ in page_records}) < 2:
                    continue
                has_same_page_conflict = True
                first_value, first_evidence = page_records[0]
                different = next(
                    (ev for value, ev in page_records if value != first_value), None
                )
                if different is None:
                    continue
                findings.append(Finding(
                    id=f"f{len(findings)+1}",
                    status="contradiction",
                    category="deadline",
                    summary_en=SUMMARY_MESSAGES["contradiction"][0],
                    summary_hi=SUMMARY_MESSAGES["contradiction"][1],
                    supporting_evidence=[first_evidence, different],
                    similarity=1.0,
                ))
            if len(by_page) > 1 and not has_same_page_conflict:
                cross_page_warnings += 1
                if cross_page_warnings <= MAX_CROSS_PAGE_DETAILS:
                    page_list = ", ".join(str(page) for page in sorted(by_page))
                    warnings.append(
                        f"{document.summary.id}: differing dates under a repeated deadline "
                        f"label on pages {page_list}; verify whether they concern the "
                        "same requirement"
                    )
        if cross_page_warnings > MAX_CROSS_PAGE_DETAILS:
            warnings.append(
                f"{document.summary.id}: {cross_page_warnings - MAX_CROSS_PAGE_DETAILS} "
                "additional repeated deadline labels need review"
            )

    for finding in findings:
        if finding.category in {"deadline", "eligibility", "fee", "time", "instruction"}:
            checklist.append(
                ChecklistItem(
                    description_en=review_messages(finding.category)[0],
                    description_hi=review_messages(finding.category)[1],
                    finding_id=finding.id,
                )
            )
    return ComparisonReport(
        documents=[old.summary, new.summary],
        findings=findings,
        checklist=checklist,
        warnings=warnings,
        text_coverage=coverage,
        fuzzy_matching_limited=fuzzy_matching_limited,
    )
