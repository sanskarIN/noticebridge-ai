"""Link an explicit old-to-new statement to the corresponding original quote."""

import re
import unicodedata
from dataclasses import dataclass
from decimal import Decimal

from .facts import AMOUNT_TOKEN, DATE_TOKEN, amount_tokens, parse_date
from .models import ParsedValue, ValueChange

CHANGE_PREFIX = re.compile(
    r"(?P<label>.+?)\s+(?:(?:has been|is|was)\s+)?"
    r"(?P<verb>changed|revised|updated|moved|rescheduled|extended|advanced|reduced|increased)"
    r"\s+from",
)
QUALIFIED_LABEL = re.compile(
    r"\b(?:(?:could|might|may|would|will|should|can)\s+(?:be|have(?:\s+been)?)"
    r"|(?:has|have|had|is|was|were)\s+not(?:\s+been)?)$"
)
AmendmentKey = tuple[str, str, str]


@dataclass(frozen=True)
class Statement:
    key: AmendmentKey
    value: ParsedValue


def _normalize(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def _label(text: str) -> str:
    return _normalize(text).removeprefix("the ")


def _parsed(token: str, category: str) -> ParsedValue:
    return parse_date(token) if category == "deadline" else amount_tokens(token)[0]


def original_statement(text: str, category: str) -> Statement | None:
    if category not in ("deadline", "fee"):
        return None
    tokens = list((DATE_TOKEN if category == "deadline" else AMOUNT_TOKEN).finditer(text))
    if len(tokens) != 1:
        return None
    token = tokens[0]
    prefix = text[:token.start()].strip()
    if not prefix.endswith(":") or text[token.end():].strip() not in ("", "."):
        return None
    label = _label(prefix[:-1])
    value = _parsed(token[0], category)
    if not label or value.canonical is None:
        return None
    return Statement((category, label, value.canonical), value)


def revised_amendment(text: str, category: str) -> Statement | None:
    if category not in ("deadline", "fee"):
        return None
    tokens = list((DATE_TOKEN if category == "deadline" else AMOUNT_TOKEN).finditer(text))
    if len(tokens) != 2:
        return None
    before_token, after_token = tokens
    prefix = CHANGE_PREFIX.fullmatch(_normalize(text[:before_token.start()]))
    if (
        prefix is None
        or QUALIFIED_LABEL.search(prefix["label"]) is not None
        or _normalize(text[before_token.end():after_token.start()]) != "to"
        or text[after_token.end():].strip() not in ("", ".")
    ):
        return None
    before, after = _parsed(before_token[0], category), _parsed(after_token[0], category)
    if before.canonical is None or after.canonical is None or before.canonical == after.canonical:
        return None
    verb = prefix["verb"]
    if verb in ("extended", "advanced", "rescheduled"):
        if category != "deadline":
            return None
        if verb == "extended" and after.canonical <= before.canonical:
            return None
        if verb == "advanced" and after.canonical >= before.canonical:
            return None
    if verb in ("reduced", "increased"):
        if category != "fee":
            return None
        decreased = Decimal(after.canonical[4:]) < Decimal(before.canonical[4:])
        if (verb == "reduced") != decreased:
            return None
    return Statement((category, _label(prefix["label"]), before.canonical), after)


def linked_amendment(original: Statement, amendment: Statement) -> ValueChange:
    return ValueChange(
        kind=original.value.kind, original=original.value, revised=amendment.value,
        outcome="uncertain",
    )
