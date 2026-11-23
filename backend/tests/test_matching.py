import pytest

from noticebridge import matching
from noticebridge.compare import compare_documents
from noticebridge.extract import extract_pdf


def test_common_tokens_do_not_favor_pdf_order(monkeypatch):
    monkeypatch.setattr(matching, "MAX_TOKEN_POSTINGS", 2)
    old = [("deadline", "existing filing deadline for cedar")]
    new = [
        ("deadline", "filing deadline for oak"),
        ("deadline", "filing deadline for ash"),
        ("deadline", "new filing deadline for cedar"),
    ]

    proposals, limited = matching.fuzzy_proposals(old, new, {0}, {0, 1, 2})

    assert limited
    assert [(oi, ni) for _, oi, ni in proposals] == [(0, 2)]


def test_oversized_candidate_sets_skip_the_entire_passage(monkeypatch):
    monkeypatch.setattr(matching, "MAX_CANDIDATES_PER_PASSAGE", 2)
    old = [("general", "study alpha bravo charlie briefing")]
    new = [("general", f"study {token} briefing") for token in ("alpha", "bravo", "charlie")]

    assert matching.fuzzy_proposals(old, new, {0}, {0, 1, 2}) == ([], True)


@pytest.mark.parametrize("constraint", ["MAX_FUZZY_PAIRS", "MAX_FUZZY_WORK"])
def test_total_budget_preserves_exact_context_and_returns_partial_fuzzy_results(
    pdf_bytes, monkeypatch, constraint,
):
    old = extract_pdf(
        pdf_bytes([[
            "Phase 1 deadline: 13 December 2026",
            "Paper A fee: Rs. 200",
            "Application deadline: 15 December 2026",
        ]]),
        document_id="original", filename="old.pdf",
    )
    new = extract_pdf(
        pdf_bytes([[
            "Phase 2 deadline: 14 December 2026",
            "Paper B fee: Rs. 300",
            "Application deadline: 16 December 2026",
        ]]),
        document_id="revised", filename="new.pdf",
    )
    monkeypatch.setattr(
        matching, constraint,
        1 if constraint == "MAX_FUZZY_PAIRS" else len("phase 1 deadline: [date]") ** 2,
    )
    report = compare_documents(old, new)

    assert report.fuzzy_matching_limited
    assert report.text_coverage == "all_pages_have_text"
    assert [finding.status for finding in report.findings] == [
        "possible_change", "missing_information", "confirmed_change", "missing_information",
    ]
    assert report.findings[2].field_changes[0].outcome == "changed"


def test_long_fuzzy_passages_do_not_suppress_exact_matches(monkeypatch, pdf_bytes):
    monkeypatch.setattr(matching, "MAX_FUZZY_CONTEXT", 25)
    old = extract_pdf(
        pdf_bytes([["Application deadline: 13 December 2026", "The North Wing reception opens"]]),
        document_id="original", filename="old.pdf",
    )
    new = extract_pdf(
        pdf_bytes([["Application deadline: 14 December 2026", "The West Wing reception opens"]]),
        document_id="revised", filename="new.pdf",
    )
    report = compare_documents(old, new)

    assert report.fuzzy_matching_limited
    assert report.findings[0].status == "confirmed_change"
    assert [f.status for f in report.findings[1:]] == ["missing_information"] * 2
