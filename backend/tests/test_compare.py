from noticebridge.compare import compare_documents
from noticebridge.extract import extract_pdf


def _pair(pdf_bytes, a, b):
    return (
        extract_pdf(pdf_bytes([[a]]), document_id="original", filename="a.pdf"),
        extract_pdf(pdf_bytes([[b]]), document_id="revised", filename="b.pdf"),
    )


def test_evidence_linked_deadline_change(pdf_bytes):
    report = compare_documents(*_pair(
        pdf_bytes, "Application deadline: 12 December 2026", "Application deadline: 19 December 2026"
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
