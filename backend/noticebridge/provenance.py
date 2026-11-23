"""Fail-closed consistency checks across a worker's PDF comparison report.

These checks do not independently reparse the PDF: they bind reported document
fingerprints and source metadata to the exact bytes received by the API, and
reject contradictory, fabricated-role or self-certified evidence structures.
"""

import hashlib
import math

from .extract import MAX_EXTRACTED_LINES, MAX_OCR_PAGES, MAX_PAGES
from .models import ComparisonReport, Evidence

EXPECTED_POLICY = ComparisonReport.model_fields["verification_policy"].default


class InvalidReportProvenance(ValueError):
    """The worker output violates the evidence consistency contract."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise InvalidReportProvenance(message)


def verify_report_provenance(
    report: ComparisonReport,
    *,
    original: bytes,
    revised: bytes,
    old_name: str,
    new_name: str,
    semantic_requested: bool = False,
    ocr_requested: bool = False,
) -> None:
    """Validate document IDs, uploaded bytes, source references and claims."""
    _require(len(report.documents) == 2, "Expected exactly two document summaries")
    _require(
        [document.id for document in report.documents] == ["original", "revised"],
        "Document roles are missing, duplicated or swapped",
    )
    _require(
        report.verification_policy == EXPECTED_POLICY,
        "Worker attempted to change the source verification policy",
    )
    summaries = dict(zip(("original", "revised"), report.documents, strict=True))
    sources = {
        "original": (original, old_name),
        "revised": (revised, new_name),
    }
    for role, document in summaries.items():
        source_bytes, expected_name = sources[role]
        _require(
            document.sha256 == hashlib.sha256(source_bytes).hexdigest(),
            f"{role} document fingerprint does not match the uploaded bytes",
        )
        _require(document.filename == expected_name, f"{role} filename was changed")
        _require(1 <= document.page_count <= MAX_PAGES, f"{role} page count is invalid")
        _require(
            0 <= document.line_count <= MAX_EXTRACTED_LINES,
            f"{role} line count is outside the parser budget",
        )
        _require(
            document.has_extractable_text == (document.line_count > 0),
            f"{role} extractable-text flag contradicts the reported lines",
        )
        _require(
            0 <= document.ocr_page_count <= min(MAX_OCR_PAGES, document.pages_with_text),
            f"{role} OCR count is inconsistent with text-covered pages",
        )
        if not ocr_requested:
            _require(document.ocr_page_count == 0, "OCR was used without opt-in")
        empty_pages = document.pages_without_text
        _require(
            empty_pages == sorted(set(empty_pages))
            and all(1 <= page <= document.page_count for page in empty_pages),
            f"{role} uncovered page indices are invalid or duplicated",
        )
        _require(
            document.pages_with_text + len(empty_pages) == document.page_count,
            f"{role} extraction coverage does not account for every page",
        )
        _require(
            document.line_count >= document.pages_with_text,
            f"{role} text-covered pages have no corresponding lines",
        )

    if any(document.line_count == 0 for document in report.documents):
        coverage = "inconclusive"
    elif any(document.pages_without_text for document in report.documents):
        coverage = "partial"
    else:
        coverage = "all_pages_have_text"
    _require(report.text_coverage == coverage, "Reported extraction coverage is inconsistent")

    def check_evidence(evidence: Evidence, expected_role: str | None = None) -> None:
        role = evidence.document_id
        _require(expected_role is None or role == expected_role, "Evidence has the wrong role")
        document = summaries[role]
        _require(evidence.filename == document.filename, "Evidence filename is inconsistent")
        _require(
            1 <= evidence.page <= document.page_count,
            "Evidence points outside its uploaded document",
        )
        x0, y0, x1, y1 = evidence.bbox
        _require(
            all(math.isfinite(value) for value in evidence.bbox)
            and x0 < x1 and y0 < y1,
            "Evidence contains invalid source coordinates",
        )
        _require(bool(evidence.text.strip()), "Evidence has no source quotation")
        if not ocr_requested:
            _require(
                evidence.extraction_method == "native",
                "OCR evidence appeared without opt-in",
            )

    # Every AI suggestion must be traceable to the original unmatched
    # deterministic evidence that is still present in this exact report.
    unmatched_old = {
        (f.category, f.original.model_dump_json())
        for f in report.findings
        if f.status == "missing_information" and f.original and not f.revised
        and f.match_method == "deterministic"
    }
    unmatched_new = {
        (f.category, f.revised.model_dump_json())
        for f in report.findings
        if f.status == "missing_information" and f.revised and not f.original
        and f.match_method == "deterministic"
    }
    ai_old_used: set[tuple[str, str]] = set()
    ai_new_used: set[tuple[str, str]] = set()
    finding_ids: set[str] = set()
    ai_proposals = 0
    for finding in report.findings:
        _require(finding.id not in finding_ids, "Finding IDs must be unique")
        finding_ids.add(finding.id)
        _require(not finding.authority_verified, "Worker claimed unverified official authority")
        if finding.original:
            check_evidence(finding.original, "original")
        if finding.revised:
            check_evidence(finding.revised, "revised")
        for evidence in finding.supporting_evidence:
            check_evidence(evidence)

        if finding.status == "missing_information":
            _require(
                (finding.original is None) != (finding.revised is None),
                "Unmatched statement must have one source passage",
            )
        elif finding.status == "contradiction":
            evidence = finding.supporting_evidence
            _require(
                len(evidence) >= 2
                and all(item.extraction_method == "native" for item in evidence)
                and len({item.document_id for item in evidence}) == 1,
                "Contradiction must have native support from one PDF",
            )
        else:
            _require(
                finding.original is not None and finding.revised is not None,
                "Related passages must include both PDF sources",
            )

        if finding.status == "confirmed_change":
            _require(
                finding.match_method == "deterministic"
                and finding.original is not None
                and finding.revised is not None
                and finding.original.extraction_method == "native"
                and finding.revised.extraction_method == "native",
                "A confirmed text change cannot depend on OCR or model inference",
            )

        if finding.match_method == "semantic_proposal":
            ai_proposals += 1
            _require(
                finding.status == "possible_change"
                and finding.similarity == 0
                and finding.category != "general"
                and not finding.field_changes
                and finding.original is not None
                and finding.revised is not None,
                "Unverified model proposals must not carry confirmed facts",
            )
            old_ref = (finding.category, finding.original.model_dump_json())
            new_ref = (finding.category, finding.revised.model_dump_json())
            _require(
                old_ref in unmatched_old and new_ref in unmatched_new,
                "AI proposal must reference original unmatched source evidence",
            )
            _require(
                old_ref not in ai_old_used and new_ref not in ai_new_used,
                "AI proposals must not reuse an unmatched source passage",
            )
            ai_old_used.add(old_ref)
            ai_new_used.add(new_ref)
        for value in finding.field_changes:
            _require(
                value.kind == value.original.kind == value.revised.kind,
                "Parsed values have inconsistent kinds",
            )
            if value.outcome in ("changed", "same_value"):
                _require(
                    value.original.canonical is not None
                    and value.revised.canonical is not None,
                    "Claimed field delta is missing canonical evidence",
                )

    checklist_ids: set[str] = set()
    for item in report.checklist:
        _require(item.finding_id in finding_ids, "Checklist references a missing finding")
        _require(item.finding_id not in checklist_ids, "Duplicate review checklist entry")
        checklist_ids.add(item.finding_id)
        _require(item.requires_human_verification, "Human review was disabled")

    _require(
        (report.semantic_assistance == "proposals_added") == (ai_proposals > 0),
        "Semantic assistance outcome does not match the proposed findings",
    )
    if semantic_requested:
        _require(
            report.semantic_assistance != "not_requested",
            "Opted-in semantic assistance outcome was omitted",
        )
    else:
        _require(
            report.semantic_assistance == "not_requested" and ai_proposals == 0,
            "Semantic assistance appeared without opt-in",
        )
