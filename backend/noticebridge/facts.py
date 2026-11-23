"""Conservative extraction of deadline/fee values from notice passages.

A raw token is evidence; a parsed value is only a *syntactic* interpretation,
never a statement about the authority or correctness of the issuing notice.
Ambiguous numeric dates are deliberately not resolved using the user's locale.
"""

import re
import unicodedata
from datetime import date
from decimal import Decimal, InvalidOperation

from .models import ParsedValue, ValueChange

MONTHS = {
    "jan": 1, "january": 1, "जनवरी": 1,
    "feb": 2, "february": 2, "फरवरी": 2, "फ़रवरी": 2,
    "mar": 3, "march": 3, "मार्च": 3,
    "apr": 4, "april": 4, "अप्रैल": 4,
    "may": 5, "मई": 5,
    "jun": 6, "june": 6, "जून": 6,
    "jul": 7, "july": 7, "जुलाई": 7,
    "aug": 8, "august": 8, "अगस्त": 8,
    "sep": 9, "sept": 9, "september": 9, "सितंबर": 9, "सितम्बर": 9,
    "oct": 10, "october": 10, "अक्टूबर": 10,
    "nov": 11, "november": 11, "नवंबर": 11, "नवम्बर": 11,
    "dec": 12, "december": 12, "दिसंबर": 12, "दिसम्बर": 12,
}

MONTH_WORDS = "|".join(re.escape(k) for k in sorted(MONTHS, key=len, reverse=True))
# Python's \w covers letters and numbers but omits Devanagari combining marks.
# Include the marks without treating the danda or double danda as word characters.
WORD_CHAR = r"[\w\u0900-\u0903\u093a-\u094f\u0951-\u0957\u0962-\u0963]"
ISO_DATE = re.compile(r"\d{4}-\d{1,2}-\d{1,2}")
NUMERIC_DATE = re.compile(r"(\d{1,2})([/.-])(\d{1,2})\2(\d{4})")
DATE_TOKEN = re.compile(
    rf"(?<!{WORD_CHAR})(?<!\d[/.-])(?:{ISO_DATE.pattern}|"
    rf"\d{{1,2}}[/.-]\d{{1,2}}[/.-]\d{{4}}|"
    rf"\d{{1,2}}\s+(?:{MONTH_WORDS})\s+\d{{4}})(?!{WORD_CHAR}|[/.-]\d)",
    re.IGNORECASE,
)
AMOUNT_DIGITS = r"\d+(?:,\d+)*(?:\.\d{1,2})?"
AMOUNT_TOKEN = re.compile(
    rf"(?<!{WORD_CHAR}|[+\-−])(?<!\d[.,/])(?:"
    rf"(?:₹\s*|Rs\.?\s*|INR\s+)(?P<prefixed>{AMOUNT_DIGITS})|"
    rf"(?P<suffixed>{AMOUNT_DIGITS})\s+(?:रुपये|रुपए|रुपया)"
    rf")(?!{WORD_CHAR}|[.,/]\d)",
    re.IGNORECASE,
)


def ascii_digits(value: str) -> str:
    """Normalize decimal digits in Hindi and other Unicode scripts to ASCII."""
    return "".join(str(unicodedata.decimal(c)) if c.isdecimal() else c for c in value)


def _valid_date(year: int, month: int, day: int) -> str | None:
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def parse_date(token: str) -> ParsedValue:
    """Only canonicalize dates with a unique calendar interpretation.

    Numeric DD/MM vs MM/DD dates are ambiguous when both parts <=12 and differ.
    An ISO YYYY-MM-DD date has an unambiguous order. Numeric days >12 use DMY.
    """
    raw = token
    cleaned = ascii_digits(unicodedata.normalize("NFKC", token)).strip()
    words = cleaned.casefold().split()
    if len(words) == 3 and words[1] in MONTHS:
        try:
            canonical = _valid_date(int(words[2]), MONTHS[words[1]], int(words[0]))
        except ValueError:
            canonical = None
        return ParsedValue(kind="date", raw=raw, canonical=canonical,
                           confidence="parsed" if canonical else "invalid")
    if ISO_DATE.fullmatch(cleaned):
        year, month, day = map(int, cleaned.split("-"))
        canonical = _valid_date(year, month, day)
        return ParsedValue(kind="date", raw=raw, canonical=canonical,
                           confidence="parsed" if canonical else "invalid")
    numeric = NUMERIC_DATE.fullmatch(cleaned)
    if numeric is None:
        return ParsedValue(kind="date", raw=raw, confidence="invalid")
    a, b, year = map(int, (numeric[1], numeric[3], numeric[4]))
    day_first = _valid_date(year, b, a)
    month_first = _valid_date(year, a, b)
    if month_first and month_first != day_first:
        # This prototype does not infer US ordering from the source locale.
        return ParsedValue(kind="date", raw=raw, confidence="ambiguous")
    return ParsedValue(kind="date", raw=raw, canonical=day_first,
                       confidence="parsed" if day_first else "invalid")


def date_tokens(text: str) -> list[ParsedValue]:
    return [parse_date(match.group(0)) for match in DATE_TOKEN.finditer(text)]


def amount_tokens(text: str) -> list[ParsedValue]:
    values: list[ParsedValue] = []
    for match in AMOUNT_TOKEN.finditer(text):
        token = match.group(0)
        digits = ascii_digits(match["prefixed"] or match["suffixed"])
        whole = digits.split(".", 1)[0]
        groups = whole.split(",")
        valid_grouping = (
            len(groups) == 1
            or (
                1 <= len(groups[0]) <= 3
                and len(groups[-1]) == 3
                and all(len(g) == 2 for g in groups[1:-1])
            )
            or (
                1 <= len(groups[0]) <= 3
                and all(len(g) == 3 for g in groups[1:])
            )
        )
        try:
            amount = Decimal(digits.replace(",", "")) if valid_grouping else None
            canonical = f"INR {amount:.2f}" if amount is not None else None
        except InvalidOperation:
            canonical = None
        values.append(ParsedValue(
            kind="amount", raw=token, canonical=canonical,
            confidence="parsed" if canonical is not None else "invalid",
        ))
    return values


def field_changes(
    original: str, revised: str, *, category: str, pairing_confirmed: bool = True,
) -> list[ValueChange]:
    """Return auditable field deltas, not semantic or authority conclusions."""
    token_sets: list[tuple[str, list[ParsedValue], list[ParsedValue]]] = []
    if category == "deadline":
        token_sets.append(("date", date_tokens(original), date_tokens(revised)))
    if category == "fee":
        token_sets.append(("amount", amount_tokens(original), amount_tokens(revised)))
    changes: list[ValueChange] = []
    for kind, old, new in token_sets:
        # A paragraph with several dates cannot be reliably aligned token by token.
        if len(old) != 1 or len(new) != 1:
            continue
        a, b = old[0], new[0]
        if pairing_confirmed and a.canonical is not None and b.canonical is not None:
            outcome = "changed" if a.canonical != b.canonical else "same_value"
        else:
            outcome = "uncertain"
        changes.append(ValueChange(kind=kind, original=a, revised=b, outcome=outcome))
    return changes
