"""Regression guards: raw dates are evidence but parsing can be ambiguous."""

import pytest

from noticebridge.facts import amount_tokens, date_tokens, field_changes, parse_date


@pytest.mark.parametrize(("token", "canonical"), [
    ("13 December 2026", "2026-12-13"),
    ("13 Dec 2026", "2026-12-13"),
    ("December 13, 2026", "2026-12-13"),
    ("DEC. 13, 2026", "2026-12-13"),
    ("13 December, 2026", "2026-12-13"),
    ("13 Dec. 2026", "2026-12-13"),
    ("13 दिसंबर 2026", "2026-12-13"),
    ("१३ दिसंबर २०२६", "2026-12-13"),
    ("2026-12-13", "2026-12-13"),
    ("13/12/2026", "2026-12-13"),
    ("12/12/2026", "2026-12-12"),
    ("29 February 2028", "2028-02-29"),
    ("February 29, 2028", "2028-02-29"),
    ("1st December 2026", "2026-12-01"),
    ("December 2nd, 2026", "2026-12-02"),
    ("3ʳᵈ December 2026", "2026-12-03"),
    ("11th September 2026", "2026-09-11"),
    ("12th Sept. 2026", "2026-09-12"),
    ("13 th December 2026", "2026-12-13"),
    ("21ST-Dec-2026", "2026-12-21"),
    ("22nd ‐ Dec ‐ 2026", "2026-12-22"),
    ("23rd‑Dec‑2026", "2026-12-23"),
    ("Dec. 31st, 2026", "2026-12-31"),
])
def test_unambiguous_dates(token, canonical):
    parsed = parse_date(token)
    assert parsed.confidence == "parsed"
    assert parsed.canonical == canonical


@pytest.mark.parametrize("token", ["01/02/2026", "02-01-2026", "12/13/2026"])
def test_ambiguous_numeric_date_is_not_guessed(token):
    parsed = parse_date(token)
    assert parsed.confidence == "ambiguous"
    assert parsed.canonical is None


@pytest.mark.parametrize("token", [
    "31 February 2026", "2026-02-30", "32/12/2026", "12/32/2026",
    "01/02/0000", "13/12-2026", "February 29, 2026", "November 31, 2026", "Aprıl 14, 2026",
    "not-a-date",
    "11st Dec 2026", "December 22th, 2026", "31st-Nov-2026", "29th-Feb-2026",
])
def test_invalid_calendar_dates(token):
    parsed = parse_date(token)
    assert parsed.confidence == "invalid"
    assert parsed.canonical is None


def test_hindi_date_extracted_from_full_statement():
    values = date_tokens("अंतिम तिथि १३ दिसंबर २०२६ है।")
    assert len(values) == 1
    assert values[0].canonical == "2026-12-13"


def test_date_extractor_does_not_salvage_fragments_from_a_longer_numeric_token():
    dates = date_tokens("Reference 17/13/12/2026, Annex 2026-12-13-12, close 13.12.2026.")
    assert [(value.raw, value.canonical) for value in dates] == [
        ("13.12.2026", "2026-12-13"),
    ]


def test_named_month_extraction_preserves_written_format_and_token_boundaries():
    values = date_tokens(
        "Ref xDecember 13, 2026 and July 8, 20261. "
        "Close December 13, 2026; correction Dec. 19, 2026."
    )
    assert [(date.raw, date.canonical) for date in values] == [
        ("December 13, 2026", "2026-12-13"), ("Dec. 19, 2026", "2026-12-19"),
    ]


@pytest.mark.parametrize("text", [
    "13-15 December 2026", "13th–15th December 2026", "13th to 15th-Dec-2026",
    "December 13th–15th, 2026", "13 - 15-Dec-2026", "13–15‑Dec‑2026",
    "29th November – 2nd December 2026", "November 29th through December 2nd, 2026",
    "13th/15th Dec 2026", "13th and 15th Dec 2026", "Dec 13th or 15th, 2026",
])
def test_compact_date_ranges_keep_both_endpoints_without_a_single_date(text):
    (parsed,) = date_tokens(f"Registration deadline: {text}.")
    assert parsed.raw == text
    assert parsed.confidence == "ambiguous"
    assert parsed.canonical is None


def test_named_date_fragments_inside_references_are_not_independent_values():
    values = date_tokens("Ref: FORM-13-Dec-2026 and 14-Dec-2026-REV. Close 15th-Dec-2026.")
    assert [(value.raw, value.canonical) for value in values] == [
        ("15th-Dec-2026", "2026-12-15"),
    ]


def test_full_ordinal_values_and_superscripts_survive_token_extraction():
    values = date_tokens("Call: 1ˢᵗ Oct 2026; deadline: 2 ⁿᵈ Sept. 2026; review: 13ᵗʰ-Dec-2026.")
    assert [(value.raw, value.canonical) for value in values] == [
        ("1ˢᵗ Oct 2026", "2026-10-01"), ("2 ⁿᵈ Sept. 2026", "2026-09-02"),
        ("13ᵗʰ-Dec-2026", "2026-12-13"),
    ]


def test_equal_dates_written_differently():
    changes = field_changes(
        "Deadline: 13 December 2026", "Deadline: 13/12/2026", category="deadline"
    )
    assert len(changes) == 1
    assert changes[0].outcome == "same_value"


def test_date_difference_can_be_verified_syntactically():
    changes = field_changes(
        "Deadline 13 December 2026", "Deadline 14 December 2026", category="deadline"
    )
    assert changes[0].outcome == "changed"
    assert changes[0].original.canonical == "2026-12-13"
    assert changes[0].revised.canonical == "2026-12-14"


def test_unreliable_numeric_date_yields_uncertain_outcome():
    changes = field_changes("Deadline: 01/02/2026", "Deadline: 02/01/2026", category="deadline")
    assert changes[0].outcome == "uncertain"


def test_fee_change_has_canonical_amounts():
    changes = field_changes("Application fee Rs. 1,000", "Application fee ₹1,200", category="fee")
    assert changes[0].outcome == "changed"
    assert changes[0].original.canonical == "INR 1000.00"
    assert changes[0].revised.canonical == "INR 1200.00"


def test_fee_extractor_does_not_treat_plain_number_as_fee():
    assert amount_tokens("Page 100") == []


def test_multiple_dates_not_arbitrarily_aligned():
    assert field_changes(
        "Dates 13 Dec 2026 / 14 Dec 2026", "Date 15 Dec 2026", category="deadline"
    ) == []


def test_invalid_comma_grouping_is_not_verified():
    parsed = amount_tokens("Fee Rs. 1,2,3")[0]
    assert parsed.confidence == "invalid"
    assert parsed.canonical is None


def test_indian_currency_grouping():
    assert amount_tokens("Fee ₹10,00,000")[0].canonical == "INR 1000000.00"


@pytest.mark.parametrize(("text", "token", "canonical"), [
    ("Fee: Rs. 500.", "Rs. 500", "INR 500.00"),
    ("Fee: INR 250.50, payable online.", "INR 250.50", "INR 250.50"),
    ("आवेदन शुल्क १,२५० रुपये।", "१,२५० रुपये", "INR 1250.00"),
    ("आवेदन शुल्क ₹७५०/-।", "₹७५०", "INR 750.00"),
])
def test_currency_parsing_preserves_quotes_and_handles_sentence_endings(text, token, canonical):
    assert [(value.raw, value.canonical) for value in amount_tokens(text)] == [(token, canonical)]


@pytest.mark.parametrize("text", [
    "Fee Rs 500.509", "Fee ₹500/100", "Fee -250 रुपये", "Fee 1/250 रुपये",
    "Fee 250 रुपयेशुल्क",
])
def test_currency_parsing_does_not_return_a_partial_number(text):
    assert amount_tokens(text) == []


@pytest.mark.parametrize(("clock", "expected"), [
    ("17:00", "17:00"),
    ("5:00 p.m.", "17:00"),
    ("5PM", "17:00"),
    ("12 a.m.", "00:00"),
    ("12:00 PM", "12:00"),
    ("07:30", "07:30"),
    ("०७：३०", "07:30"),
])
def test_clock_values_preserve_the_printed_token(clock, expected):
    (change,) = field_changes(
        f"Reporting time: {clock}", "Reporting time: 14:00", category="time",
    )
    assert change.kind == "time"
    assert change.original.raw == clock
    assert change.original.canonical == expected
    assert change.revised.canonical == "14:00"
    assert change.outcome == "changed"


@pytest.mark.parametrize(("clock", "confidence"), [
    ("5:00", "ambiguous"),
    ("24:00", "invalid"),
    ("17:99", "invalid"),
    ("13 PM", "invalid"),
])
def test_ambiguous_or_invalid_clocks_stay_uncertain(clock, confidence):
    (change,) = field_changes(
        f"Reporting time: {clock}", "Reporting time: 17:00", category="time",
    )
    assert change.original.confidence == confidence
    assert change.original.canonical is None
    assert change.outcome == "uncertain"


@pytest.mark.parametrize("clock", [
    "17:00-18:00", "5–7 PM", "17:00 to 18", "17:00 and 21:00",
    "17:00:30", "17:000", "DOC-17:00", "1-17:00", "UTC+05:30",
    "17:00+05:30", "-17:00", "+17:00",
])
def test_clock_extractor_does_not_salvage_partial_or_unpaired_clocks(clock):
    assert field_changes(
        f"Reporting time: {clock}", "Reporting time: 17:00", category="time",
    ) == []


def test_equivalent_clock_formats_match_with_an_explicit_offset():
    (change,) = field_changes(
        "Reporting time: 5:30 PM UTC + 05:30", "Reporting time: 17:30 UTC + 05:30",
        category="time",
    )
    assert change.outcome == "same_value"
    assert change.original.canonical == change.revised.canonical == "17:30"
