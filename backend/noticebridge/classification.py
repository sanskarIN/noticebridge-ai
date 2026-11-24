"""Shared passage classification and normalization for matching and extraction."""

import re
import unicodedata

from .facts import WORD_CHAR

SPACE = re.compile(r"\s+")

CATEGORIES = (
    (
        "deadline",
        (
            "deadline", "last date", "closing date", "due date", "apply by",
            "last day to apply", "last day for submission", "final date for submission",
            "application closes", "registration closes", "submission closes",
            "अंतिम तिथि", "अंतिम तारीख",
        ),
    ),
    (
        "eligibility",
        ("eligib", "ineligib", "qualification", "required degree", "पात्रता", "योग्यता"),
    ),
    ("fee", ("application fee", "fees", "fee", "payment", "शुल्क", "फीस")),
    (
        "time",
        (
            "exam time", "reporting time", "interview time", "time of",
            "closing time", "gate closes at", "entry closes at",
            "exam starts at", "interview starts at", "reporting starts at",
            "exam start time", "test start time", "examination time", "समय",
        ),
    ),
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
