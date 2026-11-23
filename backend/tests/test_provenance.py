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
    ("nonfinite_geometry", "geometry"),
    ("off_page_box", "outside the source page"),
    ("overlong_quote", "overlong"),
    ("unopted_ocr", "without opt-in"),
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
    ("forged_same_value", "Structured field claims"),
    ("forged_canonical_value", "Structured field claims"),
    ("forged_raw_date", "Structured field claims"),
    ("missing_review_task", "checklist is missing"),
    ("fake_identical_confirmation", "identical source wording"),
    ("wrong_deterministic_category", "category contradicts"),
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
    elif mutation == "nonfinite_geometry":
        finding.original.page_width = float("inf")
    elif mutation == "off_page_box":
        finding.original.bbox = (9000, 9000, 9010, 9010)
    elif mutation == "overlong_quote":
        finding.original.text = "X" * 5001
    elif mutation == "unopted_ocr":
        finding.original.extraction_method = "ocr"
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
    elif mutation == "forged_same_value":
        finding.field_changes[0].outcome = "same_value"
    elif mutation == "forged_canonical_value":
        finding.field_changes[0].revised.canonical = "2026-12-99"
    elif mutation == "forged_raw_date":
        finding.field_changes[0].original.raw = "1 January 2000"
    elif mutation == "missing_review_task":
        report.checklist.clear()
    elif mutation == "fake_identical_confirmation":
        finding.revised.text = finding.original.text
    elif mutation == "wrong_deterministic_category":
        finding.category = "fee"

    with pytest.raises(InvalidReportProvenance, match=expected_error):
        verify_report_provenance(
            report, original=original, revised=revised,
            old_name="old.pdf", new_name="new.pdf",
        )


@pytest.fixture
def ai_report(pdf_bytes, monkeypatch):
    from noticebridge import semantic

    original = pdf_bytes([["Deadline: 13 December 2026"]])
    revised = pdf_bytes([["Apply by 14 December 2026"]])
    old_doc = extract_pdf(original, document_id="original", filename="old.pdf")
    new_doc = extract_pdf(revised, document_id="revised", filename="new.pdf")
    deterministic = compare_documents(old_doc, new_doc)
    old_id = next(f.id for f in deterministic.findings if f.original)
    new_id = next(f.id for f in deterministic.findings if f.revised)
    monkeypatch.setattr(semantic, "_model_pairs", lambda *args: {
        "pairs": [{"original_id": old_id, "revised_id": new_id}]
    })
    report = semantic.propose_semantic_matches(deterministic)
    assert report.semantic_assistance == "proposals_added"
    assert len(report.findings) == 3
    return original, revised, report


def test_valid_ai_suggestion_stays_unverified(ai_report):
    original, revised, report = ai_report
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

        def __init__(self, stdout):
            self.stdout = stdout

        def communicate(self, **kwargs):
            self.stdout.write(report.model_dump_json().encode("utf-8"))
            self.stdout.flush()
            return None, None

    monkeypatch.setattr(
        isolation.subprocess, "Popen",
        lambda *args, **kwargs: ForgedProcess(kwargs["stdout"]),
    )
    monkeypatch.setattr(isolation, "_attach_windows_job", lambda p: None)
    with pytest.raises(isolation.ProcessingFailed, match="invalid evidence"):
        isolation.run_isolated_comparison(
            original, revised, old_name="old.pdf", new_name="new.pdf",
            enable_ocr=False,
        )


def test_ai_output_cannot_appear_without_explicit_opt_in(ai_report):
    original, revised, report = ai_report
    with pytest.raises(InvalidReportProvenance, match="without opt-in"):
        verify_report_provenance(
            report, original=original, revised=revised,
            old_name="old.pdf", new_name="new.pdf",
            semantic_requested=False,
        )


@pytest.mark.parametrize(("mutation", "message"), [
    ("drop_old", "original unmatched"),
    ("forge_text", "original unmatched"),
    ("double_pair", "must not reuse"),
])
def test_semantic_proposals_cannot_erase_or_forge_source_evidence(
    ai_report, mutation, message
):
    original, revised, report = ai_report
    proposed = next(f for f in report.findings if f.match_method == "semantic_proposal")
    if mutation == "drop_old":
        report.findings = [
            f for f in report.findings
            if not (f.status == "missing_information" and f.original)
        ]
        report.checklist = [
            c for c in report.checklist if c.finding_id in {f.id for f in report.findings}
        ]
    elif mutation == "forge_text":
        proposed.original.text = "Invented deadline that does not appear in unmatched evidence"
    elif mutation == "double_pair":
        duplicate = proposed.model_copy(deep=True)
        duplicate.id = "ai2"
        report.findings.append(duplicate)
        report.checklist.append(report.checklist[-1].model_copy(
            update={"finding_id": "ai2"}
        ))
    with pytest.raises(InvalidReportProvenance, match=message):
        verify_report_provenance(
            report, original=original, revised=revised,
            old_name="old.pdf", new_name="new.pdf",
            semantic_requested=True,
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


def test_evidence_cannot_refer_to_uncovered_page(pdf_bytes):
    old_bytes = pdf_bytes([["Deadline: 13 December 2026"], []])
    new_bytes = pdf_bytes([["Deadline: 14 December 2026"], []])
    old_doc = extract_pdf(
        old_bytes, document_id="original", filename="old.pdf"
    )
    new_doc = extract_pdf(
        new_bytes, document_id="revised", filename="new.pdf"
    )
    report = compare_documents(old_doc, new_doc)
    assert report.text_coverage == "partial"
    report.findings[0].original.page = 2
    with pytest.raises(InvalidReportProvenance, match="without source text"):
        verify_report_provenance(
            report, original=old_bytes, revised=new_bytes,
            old_name="old.pdf", new_name="new.pdf",
        )


def test_ocr_claim_must_match_reported_document_ocr_count(source_report):
    old_bytes, new_bytes, report = source_report
    report.findings[0].status = "possible_change"
    report.findings[0].original.extraction_method = "ocr"
    with pytest.raises(InvalidReportProvenance, match="document summary"):
        verify_report_provenance(
            report, original=old_bytes, revised=new_bytes,
            old_name="old.pdf", new_name="new.pdf",
            ocr_requested=True,
        )


@pytest.mark.parametrize(("rotation", "unit"), [
    (0, 1),
    (90, 1),
    (180, 1),
    (270, 2),
])
def test_rotated_and_cropped_pdf_evidence_satisfies_provenance(rotation, unit):
    import pymupdf as fitz

    def source(day):
        document = fitz.open()
        page = document.new_page(width=600, height=800)
        page.insert_text(
            (150, 240), f"Deadline: {day} December 2026", fontsize=16
        )
        page.set_cropbox(fitz.Rect(100, 100, 500, 700))
        page.set_rotation(rotation)
        if unit != 1:
            document.xref_set_key(page.xref, "UserUnit", str(unit))
        payload = document.tobytes()
        document.close()
        return payload

    original = source(13)
    revised = source(14)
    report = compare_documents(
        extract_pdf(original, document_id="original", filename="old.pdf"),
        extract_pdf(revised, document_id="revised", filename="new.pdf"),
    )
    assert report.findings
    evidence = report.findings[0].original
    assert evidence.page_rotation == rotation
    assert evidence.page_width > 0 and evidence.page_height > 0
    verify_report_provenance(
        report, original=original, revised=revised,
        old_name="old.pdf", new_name="new.pdf",
    )


def test_ocr_source_cannot_claim_a_certain_structured_field_change(source_report):
    old_bytes, new_bytes, report = source_report
    finding = report.findings[0]
    finding.status = "possible_change"
    finding.original.extraction_method = "ocr"
    report.documents[0].ocr_page_count = 1
    with pytest.raises(InvalidReportProvenance, match="Structured field claims"):
        verify_report_provenance(
            report, original=old_bytes, revised=new_bytes,
            old_name="old.pdf", new_name="new.pdf",
            ocr_requested=True,
        )

    finding.field_changes[0].outcome = "uncertain"
    verify_report_provenance(
        report, original=old_bytes, revised=new_bytes,
        old_name="old.pdf", new_name="new.pdf",
        ocr_requested=True,
    )


@pytest.mark.parametrize("mutation", ["same_date", "different_label"])
def test_contradictions_require_two_distinct_dates_under_same_label(
    pdf_bytes, mutation
):
    original = pdf_bytes([[
        "Deadline: 13 December 2026",
        "Deadline: 14 December 2026",
    ]])
    revised = pdf_bytes([[
        "Deadline: 13 December 2026",
        "Deadline: 14 December 2026",
    ]])
    report = compare_documents(
        extract_pdf(original, document_id="original", filename="old.pdf"),
        extract_pdf(revised, document_id="revised", filename="new.pdf"),
    )
    contradiction = next(f for f in report.findings if f.status == "contradiction")
    if mutation == "same_date":
        contradiction.supporting_evidence[1].text = "Deadline: 13 December 2026"
    else:
        contradiction.supporting_evidence[1].text = "Last date: 14 December 2026"
    with pytest.raises(InvalidReportProvenance, match="distinct parsed dates"):
        verify_report_provenance(
            report, original=original, revised=revised,
            old_name="old.pdf", new_name="new.pdf",
        )

