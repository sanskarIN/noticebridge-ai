import pytest

from noticebridge.amendments import original_statement, revised_amendment
from noticebridge.compare import compare_documents
from noticebridge.extract import extract_pdf
from noticebridge.provenance import InvalidReportProvenance, verify_report_provenance


@pytest.mark.parametrize(("old", "new", "category", "before", "after"), [
    (
        "Application deadline: 19 December 2026",
        "The application deadline was advanced from December 19, 2026 to 13 December 2026.",
        "deadline", "2026-12-19", "2026-12-13",
    ),
    (
        "Application fee: Rs. 500",
        "Application fee was reduced from INR 500 to Rs. 350.",
        "fee", "INR 500.00", "INR 350.00",
    ),
])
def test_amendment_parses_values_with_matching_labels(old, new, category, before, after):
    original = original_statement(old, category)
    amendment = revised_amendment(new, category)
    assert original is not None
    assert amendment is not None
    assert original.key == amendment.key
    assert (original.value.canonical, amendment.value.canonical) == (before, after)


@pytest.mark.parametrize("text", [
    "Application deadline extended from 19 Dec 2026 to 13 Dec 2026",
    "Application deadline advanced from 13 Dec 2026 to 19 Dec 2026",
    "Application deadline revised from 01/02/2027 to 12 Feb 2027",
    "Application deadline moved from 14 Dec 2026 to 2026-12-14",
    "Application deadline could be changed from 14 Dec 2026 to 19 Dec 2026",
    "Application deadline has not been changed from 14 Dec 2026 to 19 Dec 2026",
    "Application deadline moved from 14 Dec 2026 to 19 Dec 2026 for late applications",
    "Application deadline moved from 14 Dec 2026 or 15 Dec 2026 to 19 Dec 2026",
])
def test_ambiguous_or_contradictory_phrasing_lacks_an_explicit_link(text):
    assert revised_amendment(text, "deadline") is None


@pytest.mark.parametrize("text", [
    "Application fee was reduced from Rs. 300 to Rs. 500",
    "Application fee increased from Rs. 500 to Rs. 300",
    "Application fee rescheduled from Rs. 300 to Rs. 500",
])
def test_amount_amendments_check_the_direction_stated_in_the_quote(text):
    assert revised_amendment(text, "fee") is None


def _reports(pdf_bytes, originals, updates):
    old = pdf_bytes([originals])
    new = pdf_bytes([updates])
    return old, new, compare_documents(
        extract_pdf(old, document_id="original", filename="old.pdf"),
        extract_pdf(new, document_id="revised", filename="new.pdf"),
    )


def test_unique_amendment_links_pdf_evidence_and_keeps_the_change_uncertain(pdf_bytes):
    original = "Application deadline: 19 Dec 2026"
    revised = "Application deadline revised from 19 Dec 2026 to 13 Dec 2026"
    old, new, report = _reports(pdf_bytes, [original], [revised])
    finding, = report.findings
    assert finding.status == "possible_change"
    assert finding.match_method == "explicit_amendment"
    assert finding.original.text == original
    assert finding.revised.text == revised
    assert finding.field_changes[0].revised.canonical == "2026-12-13"
    assert finding.field_changes[0].outcome == "uncertain"
    assert report.checklist[0].finding_id == finding.id

    def verify():
        verify_report_provenance(
            report, original=old, revised=new, old_name="old.pdf", new_name="new.pdf",
        )

    verify()
    finding.field_changes[0].revised.raw = "14 Dec 2026"
    with pytest.raises(InvalidReportProvenance, match="Amendment|amendment value"):
        verify()


@pytest.mark.parametrize(("original", "updated"), [
    (
        ["Application deadline: 19 Dec 2026", "Application deadline: 19 Dec 2026"],
        ["Application deadline revised from 19 Dec 2026 to 13 Dec 2026"],
    ),
    (
        ["Application deadline: 19 Dec 2026"],
        [
            "Application deadline revised from 19 Dec 2026 to 13 Dec 2026",
            "Application deadline revised from 19 Dec 2026 to 14 Dec 2026",
        ],
    ),
    (
        ["Paper 1 fee: Rs. 500"],
        ["Paper 2 fee reduced from Rs. 500 to Rs. 350"],
    ),
    (
        ["Application deadline: 20 Dec 2026"],
        ["Application deadline revised from 19 Dec 2026 to 13 Dec 2026"],
    ),
])
def test_a_link_requires_a_unique_matching_earlier_value_and_context(pdf_bytes, original, updated):
    _, _, report = _reports(pdf_bytes, original, updated)
    assert all(finding.match_method != "explicit_amendment" for finding in report.findings)
