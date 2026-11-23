"""Regression guards: raw dates are evidence but parsing can be ambiguous."""

import pytest

from noticebridge.facts import amount_tokens, date_tokens, field_changes, parse_date


@pytest.mark.parametrize(("token", "canonical"), [
    ("13 December 2026", "2026-12-13"),
    ("13 Dec 2026", "2026-12-13"),
    ("13 दिसंबर 2026", "2026-12-13"),
    ("१३ दिसंबर २०२६", "2026-12-13"),
    ("2026-12-13", "2026-12-13"),
    ("13/12/2026", "2026-12-13"),
    ("12/12/2026", "2026-12-12"),
    ("29 February 2028", "2028-02-29"),
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
    "01/02/0000", "13/12-2026", "not-a-date",
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
