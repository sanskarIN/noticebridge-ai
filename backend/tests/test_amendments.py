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


@pytest.mark.parametrize(("old", "new", "before", "after"), [
    (
        "Reporting time: 17:00",
        "Reporting time revised from 17:00 to 18:30",
        "17:00", "18:30",
    ),
    (
        "Interview time on 13 Dec 2026: 5 PM IST",
        "The interview time on 13 Dec 2026 is hereby rescheduled from 17:00 IST to 6 PM IST.",
        "17:00", "18:00",
    ),
    (
        "Exam time: 17:00 UTC+05:30",
        "Exam time was moved from 17:00 UTC+05:30 to 18:00 UTC+05:30",
        "17:00", "18:00",
    ),
])
def test_clock_amendments_preserve_label_and_printed_zone(old, new, before, after):
    original = original_statement(old, "time")
    revised = revised_amendment(new, "time")
    assert original is not None and revised is not None
    assert original.key == revised.key
    assert (original.value.canonical, revised.value.canonical) == (before, after)


@pytest.mark.parametrize("text", [
    "Reporting time revised from 17:00 IST to 18:00 UTC",
    "Reporting time revised from 17:00 to 18:00 IST",
    "Reporting time revised from 17:00 UTC+05:30 to 18:00 UTC+06:00",
    "Reporting time revised from 5:00 to 18:00",
    "Reporting time revised from 17:00 to 24:00",
    "Reporting time revised from 17:00 to 5 PM",
    "Reporting time could be changed from 17:00 to 18:00",
    "Reporting time has not been changed from 17:00 to 18:00",
    "Reporting time changed from 17:00 to 18:00 for Shift 2 only",
    "Reporting time advanced from 17:00 to 16:00",
    "Reporting time changed from 17:00-18:00 to 19:00",
    "Reporting time changed from -17:00 to 18:00",
    "Reporting time changed from 17:00 to +18:00",
])
def test_clock_amendments_do_not_infer_ambiguous_or_conditional_changes(text):
    assert revised_amendment(text, "time") is None


def test_explicit_time_amendment_is_provenance_checked_but_never_confirmed(pdf_bytes):
    old_text = "Reporting time Shift 1: 17:00 IST"
    new_text = "Reporting time Shift 1 has been revised from 5 PM IST to 18:30 IST"
    old, new, report = _reports(pdf_bytes, [old_text], [new_text])
    (finding,) = report.findings
    assert finding.status == "possible_change"
    assert finding.match_method == "explicit_amendment"
    assert finding.category == "time"
    assert finding.original.text == old_text
    assert finding.revised.text == new_text
    (delta,) = finding.field_changes
    assert (delta.kind, delta.outcome) == ("time", "uncertain")
    assert delta.original.canonical == "17:00"
    assert delta.revised.canonical == "18:30"
    assert not finding.authority_verified
    verify_report_provenance(
        report, original=old, revised=new, old_name="old.pdf", new_name="new.pdf",
    )
    delta.revised.canonical = "19:30"
    with pytest.raises(InvalidReportProvenance, match="amendment value"):
        verify_report_provenance(
            report, original=old, revised=new, old_name="old.pdf", new_name="new.pdf",
        )


@pytest.mark.parametrize("old_text", [
    "Reporting time Shift 2: 17:00 IST",
    "Reporting time Shift 1: 17:00 UTC",
    "Reporting time Shift 1: 16:00 IST",
    "Reporting time Shift 1: 17:00",
])
def test_time_amendment_must_match_original_scope_prior_value_and_zone(pdf_bytes, old_text):
    _, _, report = _reports(
        pdf_bytes, [old_text],
        ["Reporting time Shift 1 revised from 17:00 IST to 18:30 IST"],
    )
    assert not any(f.match_method == "explicit_amendment" for f in report.findings)


def test_hereby_qualified_date_amendment(pdf_bytes):
    _, _, report = _reports(
        pdf_bytes, ["Application deadline: 13 Dec 2026"],
        ["Application deadline is hereby extended from 13 Dec 2026 to 14 Dec 2026"],
    )
    (finding,) = report.findings
    assert finding.match_method == "explicit_amendment"
    assert finding.field_changes[0].outcome == "uncertain"
