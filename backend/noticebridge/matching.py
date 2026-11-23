"""Deterministic work limits for comparing and revalidating fuzzy passage matches."""

import re
from collections import defaultdict
from dataclasses import dataclass
from difflib import SequenceMatcher

from .facts import WORD_CHAR

StatementKey = tuple[str, str]
SEARCH_TOKEN = re.compile(rf"{WORD_CHAR}{{4,}}")
MIN_FUZZY_SIMILARITY = 0.66
MAX_FUZZY_CONTEXT = 512
MAX_TOKEN_POSTINGS = 64
MAX_CANDIDATES_PER_PASSAGE = 64
MAX_FUZZY_PAIRS = 20_000
MAX_FUZZY_WORK = 20_000_000


@dataclass
class FuzzyBudget:
    """Reserve each pair's worst-case character work before running a matcher."""

    pairs: int = 0
    work: int = 0

    def reserve(self, original: str, revised: str) -> bool:
        cost = len(original) * len(revised)
        if (
            max(len(original), len(revised)) > MAX_FUZZY_CONTEXT
            or self.pairs >= MAX_FUZZY_PAIRS
            or self.work + cost > MAX_FUZZY_WORK
        ):
            return False
        self.pairs += 1
        self.work += cost
        return True


def context_similarity(original: str, revised: str) -> float:
    if original == revised:
        return 1.0
    matcher = SequenceMatcher(None, original, revised, autojunk=False)
    # Both inexpensive ratios are upper bounds. Pairs below our minimum
    # cannot be reported, so they do not need the full sequence comparison.
    if (
        matcher.real_quick_ratio() < MIN_FUZZY_SIMILARITY
        or matcher.quick_ratio() < MIN_FUZZY_SIMILARITY
    ):
        return 0.0
    return matcher.ratio()


def fuzzy_proposals(
    old_keys: list[StatementKey],
    new_keys: list[StatementKey],
    unmatched_old: set[int],
    unmatched_new: set[int],
) -> tuple[list[tuple[float, int, int]], bool]:
    """Return ranked candidates and whether a search limit omitted candidates."""
    shared_categories = (
        {old_keys[index][0] for index in unmatched_old}
        & {new_keys[index][0] for index in unmatched_new}
    )
    by_token: dict[tuple[str, str], list[int]] = defaultdict(list)
    limited = False
    for ni in sorted(unmatched_new):
        category, text = new_keys[ni]
        if category not in shared_categories:
            continue
        if len(text) > MAX_FUZZY_CONTEXT:
            limited = True
            continue
        for token in set(SEARCH_TOKEN.findall(text)):
            postings = by_token[category, token]
            if len(postings) <= MAX_TOKEN_POSTINGS:
                # Keep one extra index as a marker for a saturated posting.
                postings.append(ni)

    proposals: list[tuple[float, int, int]] = []
    budget = FuzzyBudget()
    for oi in sorted(unmatched_old):
        category, text = old_keys[oi]
        if category not in shared_categories:
            continue
        if len(text) > MAX_FUZZY_CONTEXT:
            limited = True
            continue
        candidates: set[int] = set()
        for token in sorted(set(SEARCH_TOKEN.findall(text))):
            postings = by_token.get((category, token), ())
            if len(postings) > MAX_TOKEN_POSTINGS:
                # Common tokens cannot select an arbitrary prefix of the PDF.
                limited = True
                continue
            candidates.update(postings)
            if len(candidates) > MAX_CANDIDATES_PER_PASSAGE:
                break
        if len(candidates) > MAX_CANDIDATES_PER_PASSAGE:
            limited = True
            continue
        for ni in sorted(candidates):
            revised = new_keys[ni][1]
            if not budget.reserve(text, revised):
                return proposals, True
            score = context_similarity(text, revised)
            if score >= MIN_FUZZY_SIMILARITY:
                proposals.append((score, oi, ni))
    return proposals, limited
