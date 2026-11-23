"""No worker report can silently swap, forge or self-certify source evidence."""

import pytest

from noticebridge.compare import compare_documents
from noticebridge.extract import extract_pdf
from noticebridge.provenance import InvalidReportProvenance, verify_report_provenance


@pytest.fixture
def source_report(pdf_bytes):
    original = pdf_bytes([["Deadline: 13 December 2026"]])
    revised = pdf_bytes([["Deadline: 14 December 2026"]])
    old_doc = extract_pdf(original, document_id="original", filename="old.pdf")
    new_doc = extract_pdf(revised, document_id="revised", filename="new.pdf")
    report = compare_documents(old_doc, new_doc)
    assert len(report.findings) == 1
    return original, revised, report


def verify(source_report):
    original, revised, report = source_report
    verify_report_provenance(
        report, original=original, revised=revised,
        old_name="old.pdf", new_name="new.pdf",
    )


def test_valid_native_comparison_preserves_source_integrity(source_report):
    verify(source_report)


@pytest.mark.parametrize(("mutation", "expected_error"), [
    ("wrong_sha", "fingerprint"),
    ("swapped_docs", "roles"),
    ("changed_filename", "filename"),
    ("wrong_evidence_role", "wrong role"),
    ("wrong_evidence_page", "outside"),
    ("wrong_evidence_filename", "Evidence filename"),
    ("inconsistent_coverage", "coverage"),
    ("wrong_missing_page_counts", "coverage"),
    ("authority_claim", "official authority"),
    ("tampered_policy", "verification policy"),
    ("invented_checklist_id", "missing finding"),
    ("human_review_disabled", "Human review"),
    ("fake_contradiction", "Contradiction"),
    ("fake_semantic_confirmation", "confirmed text change"),
    ("duplicate_finding_id", "unique"),
    ("noncanonical_field_delta", "canonical evidence"),
])
def test_forged_report_fields_are_rejected(source_report, mutation, expected_error):
    original, revised, baseline = source_report
    report = baseline.model_copy(deep=True)
    finding = report.findings[0]
    if mutation == "wrong_sha":
        report.documents[0].sha256 = "0" * 64
    elif mutation == "swapped_docs":
        report.documents.reverse()
    elif mutation == "changed_filename":
        report.documents[1].filename = "spoofed.pdf"
    elif mutation == "wrong_evidence_role":
        finding.original.document_id = "revised"
    elif mutation == "wrong_evidence_page":
        finding.revised.page = 999
    elif mutation == "wrong_evidence_filename":
        finding.original.filename = "elsewhere.pdf"
    elif mutation == "inconsistent_coverage":
        report.text_coverage = "inconclusive"
    elif mutation == "wrong_missing_page_counts":
        report.documents[0].pages_without_text = [1]
    elif mutation == "authority_claim":
        finding.authority_verified = True
    elif mutation == "tampered_policy":
        report.verification_policy = "No human verification needed"
    elif mutation == "invented_checklist_id":
        report.checklist[0].finding_id = "not-a-finding"
    elif mutation == "human_review_disabled":
        report.checklist[0].requires_human_verification = False
    elif mutation == "fake_contradiction":
        finding.status = "contradiction"
    elif mutation == "fake_semantic_confirmation":
        finding.match_method = "semantic_proposal"
    elif mutation == "duplicate_finding_id":
        report.findings.append(finding.model_copy(deep=True))
    elif mutation == "noncanonical_field_delta":
        finding.field_changes[0].revised.canonical = None

    with pytest.raises(InvalidReportProvenance, match=expected_error):
        verify_report_provenance(
            report, original=original, revised=revised,
            old_name="old.pdf", new_name="new.pdf",
        )


def test_valid_ai_suggestion_stays_unverified(source_report):
    original, revised, report = source_report
    finding = report.findings[0]
    finding.status = "possible_change"
    finding.match_method = "semantic_proposal"
    finding.similarity = 0
    finding.field_changes = []
    report.semantic_assistance = "proposals_added"
    verify_report_provenance(
        report, original=original, revised=revised,
        old_name="old.pdf", new_name="new.pdf",
        semantic_requested=True,
    )


def test_parent_rejects_a_forged_worker_payload(monkeypatch, source_report):
    import noticebridge.isolation as isolation

    original, revised, report = source_report
    report.documents[0].sha256 = "0" * 64

    class ForgedProcess:
        returncode = 0

        def communicate(self, **kwargs):
            return report.model_dump_json().encode("utf-8"), None

    monkeypatch.setattr(
        isolation.subprocess, "Popen", lambda *args, **kwargs: ForgedProcess()
    )
    with pytest.raises(isolation.ProcessingFailed, match="invalid evidence"):
        isolation.run_isolated_comparison(
            original, revised, old_name="old.pdf", new_name="new.pdf",
            enable_ocr=False,
        )


def test_ai_output_cannot_appear_without_explicit_opt_in(source_report):
    original, revised, report = source_report
    finding = report.findings[0]
    finding.status = "possible_change"
    finding.match_method = "semantic_proposal"
    finding.similarity = 0
    finding.field_changes = []
    report.semantic_assistance = "proposals_added"
    with pytest.raises(InvalidReportProvenance, match="without opt-in"):
        verify_report_provenance(
            report, original=original, revised=revised,
            old_name="old.pdf", new_name="new.pdf",
            semantic_requested=False,
        )


def test_ocr_metadata_cannot_appear_without_explicit_opt_in(source_report):
    original, revised, report = source_report
    report.documents[0].ocr_page_count = 1
    with pytest.raises(InvalidReportProvenance, match="OCR was used without opt-in"):
        verify_report_provenance(
            report, original=original, revised=revised,
            old_name="old.pdf", new_name="new.pdf",
            ocr_requested=False,
        )

