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

