import pytest

from noticebridge.compare import compare_documents
from noticebridge.extract import extract_pdf


def _pair(pdf_bytes, a, b):
    return (
        extract_pdf(pdf_bytes([[a]]), document_id="original", filename="a.pdf"),
        extract_pdf(pdf_bytes([[b]]), document_id="revised", filename="b.pdf"),
    )


def test_evidence_linked_deadline_change(pdf_bytes):
    report = compare_documents(*_pair(
        pdf_bytes,
        "Application deadline: 12 December 2026",
        "Application deadline: 19 December 2026",
    ))
    assert len(report.findings) == 1
    f = report.findings[0]
    assert f.status == "confirmed_change"
    assert f.category == "deadline"
    assert f.original.page == f.revised.page == 1
    assert "12 December" in f.original.text
    assert "19 December" in f.revised.text
    assert not f.authority_verified
    assert report.checklist[0].requires_human_verification


@pytest.mark.parametrize(("original", "revised"), [
    ("Reporting time for Shift 1: 17:00", "Reporting time for Shift 2: 18:00"),
    ("Reporting time on 13 Dec 2026: 17:00", "Reporting time on 14 Dec 2026: 18:00"),
    ("Reporting time: 17:00 IST", "Reporting time: 18:00 UTC"),
    ("Reporting time: 17:00 UTC+05:30", "Reporting time: 18:00 UTC+06:00"),
    ("Reporting time: 17:00", "Reporting time: 18:00 IST"),
])
def test_clock_matching_preserves_schedule_scope_and_time_zone(pdf_bytes, original, revised):
    report = compare_documents(*_pair(pdf_bytes, original, revised))
    assert not any(f.status == "confirmed_change" for f in report.findings)
    assert not any(
        delta.kind == "time" and delta.outcome == "changed"
        for f in report.findings for delta in f.field_changes
    )


def test_different_clocks_do_not_create_a_calendar_date_conflict(pdf_bytes):
    old = [
        "Deadline: 13 December 2026 at 17:00",
        "Deadline: 14 December 2026 at 18:00",
    ]
    original = extract_pdf(pdf_bytes([old]), document_id="original", filename="a.pdf")
    revised = extract_pdf(pdf_bytes([old]), document_id="revised", filename="b.pdf")
    assert compare_documents(original, revised).findings == []


def test_identical_has_no_findings(pdf_bytes):
    report = compare_documents(*_pair(pdf_bytes, "Eligibility: class 12", "Eligibility: class 12"))
    assert not report.findings


def test_unmatched_is_not_assumed_removed(pdf_bytes):
    report = compare_documents(*_pair(
        pdf_bytes, "Candidates must submit photo", "Students should visit portal"
    ))
    assert len(report.findings) == 2
    assert all(f.status == "missing_information" for f in report.findings)


def test_reordered_lines_are_not_changes(pdf_bytes):
    a = extract_pdf(pdf_bytes([["Eligibility: class 12", "Fee: Rs 100"]]),
                    document_id="original", filename="a.pdf")
    b = extract_pdf(pdf_bytes([["Fee: Rs 100", "Eligibility: class 12"]]),
                    document_id="revised", filename="b.pdf")
    assert not compare_documents(a, b).findings


def test_same_document_deadline_conflict(pdf_bytes):
    a = extract_pdf(pdf_bytes([["Deadline: 12 December 2026", "Deadline: 13 December 2026"]]),
                    document_id="original", filename="a.pdf")
    b = extract_pdf(pdf_bytes([["Deadline: 12 December 2026"]]),
                    document_id="revised", filename="b.pdf")
    report = compare_documents(a, b)
    contradictions = [f for f in report.findings if f.status == "contradiction"]
    assert len(contradictions) == 1
    assert len(contradictions[0].supporting_evidence) == 2
    assert all(e.document_id == "original" for e in contradictions[0].supporting_evidence)


def test_does_not_infer_authority_from_upload_order(pdf_bytes):
    a, b = _pair(pdf_bytes, "Deadline: 12 December 2026", "Deadline: 13 December 2026")
    findings = compare_documents(a, b).findings
    assert findings[0].status == "confirmed_change"
    assert not any(f.authority_verified for f in findings)


def test_reordered_duplicate_deadlines_preserve_exact_statements(pdf_bytes):
    a = extract_pdf(pdf_bytes([["Deadline: 13 December 2026", "Deadline: 14 December 2026"]]),
                    document_id="original", filename="a.pdf")
    b = extract_pdf(pdf_bytes([["Deadline: 14 December 2026", "Deadline: 13 December 2026"]]),
                    document_id="revised", filename="b.pdf")
    report = compare_documents(a, b)
    assert not any(f.status in {"confirmed_change", "possible_change"} for f in report.findings)


def test_duplicate_context_is_not_confirmed_change(pdf_bytes):
    a = extract_pdf(pdf_bytes([["Deadline: 13 December 2026", "Deadline: 14 December 2026"]]),
                    document_id="original", filename="a.pdf")
    b = extract_pdf(pdf_bytes([["Deadline: 15 December 2026", "Deadline: 16 December 2026"]]),
                    document_id="revised", filename="b.pdf")
    changes = [f for f in compare_documents(a, b).findings if f.revised and f.original]
    assert len(changes) == 2
    assert all(f.status == "possible_change" for f in changes)
    assert all(f.field_changes[0].outcome == "uncertain" for f in changes)


@pytest.mark.parametrize(("original", "revised"), [
    ("Phase 1 deadline: 13 December 2026", "Phase 2 deadline: 14 December 2026"),
    ("Paper 1 fee: Rs. 200", "Paper 2 fee: Rs. 500"),
    ("Application deadline: 13 December 2026", "Online application deadline: 14 December 2026"),
])
def test_fuzzy_pair_does_not_certify_a_value_delta(pdf_bytes, original, revised):
    report = compare_documents(*_pair(pdf_bytes, original, revised))
    assert len(report.findings) == 1
    finding = report.findings[0]
    assert finding.status == "possible_change"
    assert finding.field_changes[0].outcome == "uncertain"
    assert finding.field_changes[0].original.canonical is not None
    assert finding.original.text == original
    assert finding.revised.text == revised


def test_distinct_numbered_deadline_labels_are_not_contradictory(pdf_bytes):
    revised_lines = [
        "Phase 1 deadline: 14 December 2026", "Phase 2 deadline: 18 December 2026",
    ]
    original_lines = [
        "Phase 2 deadline: 18 December 2026", "Phase 1 deadline: 13 December 2026",
    ]
    report = compare_documents(
        extract_pdf(pdf_bytes([original_lines]), document_id="original", filename="a.pdf"),
        extract_pdf(pdf_bytes([revised_lines]), document_id="revised", filename="b.pdf"),
    )
    assert [finding.status for finding in report.findings] == ["confirmed_change"]
    assert report.findings[0].field_changes[0].revised.canonical == "2026-12-14"
    assert not report.warnings


def test_numeric_ambiguity_does_not_create_false_contradiction(pdf_bytes):
    a = extract_pdf(pdf_bytes([["Deadline: 01/02/2026", "Deadline: 02/01/2026"]]),
                    document_id="original", filename="a.pdf")
    b = extract_pdf(pdf_bytes([["Deadline: 01/02/2026"]]),
                    document_id="revised", filename="b.pdf")
    assert not any(f.status == "contradiction" for f in compare_documents(a, b).findings)


def test_syntactic_date_delta_is_included_in_finding(pdf_bytes):
    report = compare_documents(
        *_pair(pdf_bytes, "Deadline: 13 December 2026", "Deadline: 14 December 2026")
    )
    assert report.findings[0].field_changes[0].outcome == "changed"


def test_equivalent_date_written_differently_is_not_value_change(pdf_bytes):
    report = compare_documents(
        *_pair(pdf_bytes, "Deadline: 13 December 2026", "Deadline: 13/12/2026")
    )
    assert len(report.findings) == 1
    assert report.findings[0].field_changes[0].outcome == "same_value"


def test_ocr_sources_are_not_automatically_confirmed(pdf_bytes):
    from noticebridge.models import Evidence, ExtractedLine

    old, new = _pair(
        pdf_bytes, "Deadline: 13 December 2026", "Deadline: 14 December 2026"
    )
    old_line = old.lines[0]
    old.lines[0] = ExtractedLine(text=old_line.text, evidence=Evidence(
        **{**old_line.evidence.model_dump(), "extraction_method": "ocr"}
    ))
    report = compare_documents(old, new)
    assert report.findings[0].status == "possible_change"
    assert report.findings[0].field_changes[0].outcome == "uncertain"


def test_ocr_sourced_deadlines_cannot_claim_a_contradiction(pdf_bytes):
    from noticebridge.models import Evidence, ExtractedLine

    old = extract_pdf(pdf_bytes([["Deadline: 13 December 2026", "Deadline: 14 December 2026"]]),
                      document_id="original", filename="a.pdf")
    new = extract_pdf(pdf_bytes([["Deadline: 13 December 2026"]]),
                      document_id="revised", filename="b.pdf")
    item = old.lines[1]
    old.lines[1] = ExtractedLine(text=item.text, evidence=Evidence(
        **{**item.evidence.model_dump(), "extraction_method": "ocr"}
    ))
    report = compare_documents(old, new)
    assert not any(f.status == "contradiction" for f in report.findings)


def test_text_coverage_is_complete_only_when_every_page_has_extracted_text(pdf_bytes):
    old = extract_pdf(
        pdf_bytes([["Deadline: 13 December 2026"], ["Requirements unchanged"]]),
        document_id="original", filename="old.pdf",
    )
    new = extract_pdf(
        pdf_bytes([["Deadline: 14 December 2026"], ["Requirements unchanged"]]),
        document_id="revised", filename="new.pdf",
    )
    assert compare_documents(old, new).text_coverage == "all_pages_have_text"


def test_partial_text_coverage_is_visible_even_with_valid_findings(pdf_bytes):
    old = extract_pdf(
        pdf_bytes([["Deadline: 13 December 2026"], []]),
        document_id="original", filename="old.pdf",
    )
    new = extract_pdf(
        pdf_bytes([["Deadline: 14 December 2026"], ["Information"]]),
        document_id="revised", filename="new.pdf",
    )
    report = compare_documents(old, new)
    assert report.text_coverage == "partial"
    assert any(f.status == "confirmed_change" for f in report.findings)
    assert any("omit changes" in warning for warning in report.warnings)


def test_inconclusive_text_coverage_when_either_document_has_no_text(pdf_bytes):
    old = extract_pdf(pdf_bytes([[]]), document_id="original", filename="old.pdf")
    new = extract_pdf(pdf_bytes([["Deadline: 14 December 2026"]]),
                      document_id="revised", filename="new.pdf")
    assert compare_documents(old, new).text_coverage == "inconclusive"


def test_repeated_deadline_label_across_pages_is_review_warning_not_contradiction(
    pdf_bytes,
):
    # Separate pages may concern separate phases or distinct requirements.
    old_bytes = pdf_bytes([
        ["Deadline: 13 December 2026"],
        ["Deadline: 14 December 2026"],
    ])
    new_bytes = pdf_bytes([
        ["Deadline: 13 December 2026"],
        ["Deadline: 14 December 2026"],
    ])
    old = extract_pdf(old_bytes, document_id="original", filename="old.pdf")
    new = extract_pdf(new_bytes, document_id="revised", filename="new.pdf")
    result = compare_documents(old, new)
    assert not result.findings
    assert sum("repeated deadline label on pages 1, 2" in w for w in result.warnings) == 2


def test_same_page_contradictions_remain_evidence_linked_across_multiple_pages(
    pdf_bytes,
):
    original = extract_pdf(
        pdf_bytes([
            ["Deadline: 13 December 2026", "Deadline: 14 December 2026"],
            ["Deadline: 18 December 2026", "Deadline: 19 December 2026"],
        ]),
        document_id="original", filename="old.pdf",
    )
    revised = extract_pdf(
        pdf_bytes([
            ["Deadline: 13 December 2026", "Deadline: 14 December 2026"],
            ["Deadline: 18 December 2026", "Deadline: 19 December 2026"],
        ]),
        document_id="revised", filename="new.pdf",
    )
    report = compare_documents(original, revised)
    contradictions = [f for f in report.findings if f.status == "contradiction"]
    assert len(contradictions) == 4
    assert all(
        len({e.document_id for e in f.supporting_evidence}) == 1
        and len({e.page for e in f.supporting_evidence}) == 1
        for f in contradictions
    )
    assert not any("repeated deadline label on pages" in w for w in report.warnings)


@pytest.mark.parametrize(("passage", "expected"), [
    ("Coffee break is available", "general"),
    ("Repayment details will be communicated later", "general"),
    ("The application officer is offering a new programme", "general"),
    ("Please review the certification offered", "general"),
    ("Application fee: Rs. 500", "fee"),
    ("Exam fees must be paid online", "fee"),
    ("The payment deadline is 13 December 2026", "deadline"),
    ("Eligibility: class 12", "eligibility"),
    ("Eligible applicants should apply", "eligibility"),
    ("Ineligible applicants may not register", "eligibility"),
    ("अंतिम तिथि: 13 दिसंबर 2026", "deadline"),
    ("आवेदन शुल्क: 250 रुपये", "fee"),
    ("आवेदन शुल्क।", "fee"),
    ("सभी के लिए पात्रता आवश्यक है", "eligibility"),
    ("पात्रताहीन आवेदन मान्य नहीं", "general"),
    ("Registration closes on 13 Dec 2026", "deadline"),
    ("The final date for submission is 14 Dec 2026", "deadline"),
    ("Last day to apply: 19 Dec 2026", "deadline"),
    ("Gate closing time: 17:00", "time"),
    ("Gate closes at 17:00", "time"),
    ("Examination time: 18:00", "time"),
    ("Eligibility cut-off date: 13 Dec 2026", "eligibility"),
    ("The registration closure notice is available", "general"),
    ("This application closesource reference is unrelated", "general"),
    ("The gate closes atlantis exhibit", "general"),
])
def test_category_matchers_use_token_boundaries(passage, expected):
    from noticebridge.compare import category_for

    assert category_for(passage) == expected


def test_unrelated_coffee_remarks_do_not_require_fee_verification(pdf_bytes):
    report = compare_documents(
        *_pair(
            pdf_bytes,
            "Coffee break at examination center",
            "Coffee service will not be provided",
        )
    )
    assert report.findings
    assert all(f.category == "general" for f in report.findings)
    assert not any("fee" in item.description_en.lower() for item in report.checklist)


def test_real_fee_variants_remain_evidence_backed(pdf_bytes):
    report = compare_documents(
        *_pair(pdf_bytes, "Exam fees: Rs. 200", "Exam fees: Rs. 300")
    )
    assert len(report.findings) == 1
    finding = report.findings[0]
    assert finding.category == "fee"
    assert finding.status == "confirmed_change"
    assert finding.field_changes[0].outcome == "changed"
    assert len(report.checklist) == 1



@pytest.mark.parametrize("label", [
    "Registration closes on", "Application closes on", "Last day to apply:",
    "Final date for submission:", "Submission closes on",
])
def test_english_closure_labels_support_evidence_linked_date_changes(pdf_bytes, label):
    old, new = f"{label} 13 Dec 2026", f"{label} 14 Dec 2026"
    report = compare_documents(*_pair(pdf_bytes, old, new))
    (finding,) = report.findings
    assert (finding.status, finding.category) == ("confirmed_change", "deadline")
    assert (finding.original.text, finding.revised.text) == (old, new)
    (delta,) = finding.field_changes
    assert (delta.kind, delta.outcome) == ("date", "changed")
    assert (delta.original.canonical, delta.revised.canonical) == ("2026-12-13", "2026-12-14")
    assert not finding.authority_verified
    assert report.checklist[0].finding_id == finding.id


@pytest.mark.parametrize("label", [
    "Gate closing time:", "Gate closes at", "Entry closes at",
    "Exam starts at", "Examination time:", "Reporting starts at",
])
def test_english_schedule_labels_support_evidence_linked_clock_changes(pdf_bytes, label):
    old, new = f"{label} 17:00 IST", f"{label} 18:00 IST"
    report = compare_documents(*_pair(pdf_bytes, old, new))
    (finding,) = report.findings
    assert (finding.status, finding.category) == ("confirmed_change", "time")
    assert (finding.original.text, finding.revised.text) == (old, new)
    (delta,) = finding.field_changes
    assert (delta.kind, delta.outcome) == ("time", "changed")
    assert (delta.original.canonical, delta.revised.canonical) == ("17:00", "18:00")
    assert not finding.authority_verified
    assert report.checklist[0].finding_id == finding.id


def test_eligibility_cutoff_is_not_a_deadline_change(pdf_bytes):
    report = compare_documents(*_pair(
        pdf_bytes, "Eligibility cut-off date: 13 Dec 2026",
        "Eligibility cut-off date: 14 Dec 2026",
    ))
    (finding,) = report.findings
    assert finding.category == "eligibility"
    assert not finding.field_changes
    assert not finding.authority_verified


def test_gate_closing_time_keeps_shift_and_zone_scope(pdf_bytes):
    report = compare_documents(*_pair(
        pdf_bytes, "Gate closing time Shift 1: 17:00 IST",
        "Gate closing time Shift 2: 18:00 UTC",
    ))
    assert report.findings
    assert all(f.category == "time" for f in report.findings)
    assert all(f.status != "confirmed_change" for f in report.findings)
    assert not any(delta.outcome == "changed" for f in report.findings for delta in f.field_changes)
