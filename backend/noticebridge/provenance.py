"""Fail-closed consistency checks across a worker's PDF comparison report.

These checks do not independently reparse the PDF: they bind reported document
fingerprints and source metadata to the exact bytes received by the API, and
reject contradictory, fabricated-role or self-certified evidence structures.
"""

import hashlib
import math

from .compare import anchor, category_for, context_similarity, normalize
from .extract import MAX_EXTRACTED_LINES, MAX_LINE_CHARACTERS, MAX_OCR_PAGES, MAX_PAGES
from .facts import date_tokens, field_changes
from .messages import HINDI_CATEGORY, SUMMARY_MESSAGES, review_messages
from .models import ComparisonReport, Evidence
from .warning_policy import warning_supported

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
        _require(
            math.isfinite(evidence.page_width)
            and math.isfinite(evidence.page_height),
            "Evidence contains invalid source page geometry",
        )
        # PyMuPDF always reports text boxes before page rotation. Reject a
        # wholly off-page box while allowing a legitimate partly clipped glyph.
        unrotated_width = (
            evidence.page_width if evidence.page_rotation in (0, 180)
            else evidence.page_height
        )
        unrotated_height = (
            evidence.page_height if evidence.page_rotation in (0, 180)
            else evidence.page_width
        )
        _require(
            x1 > 0 and y1 > 0
            and x0 < unrotated_width and y0 < unrotated_height,
            "Evidence source box is outside the source page",
        )
        _require(
            0 < len(evidence.text.strip()) <= MAX_LINE_CHARACTERS,
            "Evidence has an empty or overlong source quotation",
        )
        _require(
            evidence.page not in document.pages_without_text,
            "Evidence points to a page reported without source text",
        )
        if evidence.extraction_method == "ocr":
            _require(ocr_requested, "OCR evidence appeared without opt-in")
            _require(
                document.ocr_page_count > 0,
                "OCR evidence is absent from the document summary",
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
        if finding.match_method == "semantic_proposal":
            message_key = "semantic_proposal"
        elif finding.status == "missing_information":
            message_key = "missing_original" if finding.original else "missing_revised"
        else:
            message_key = finding.status
        _require(
            (finding.summary_en, finding.summary_hi) == SUMMARY_MESSAGES[message_key],
            "Finding explanation must use a verified safety-preserving template",
        )
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
            reference = finding.original or finding.revised
            _require(
                finding.category == category_for(reference.text)
                and not finding.field_changes
                and finding.match_method == "deterministic",
                "Unmatched evidence has invalid classification or field claims",
            )
        elif finding.status == "contradiction":
            evidence = finding.supporting_evidence
            _require(
                finding.original is None
                and finding.revised is None
                and finding.category == "deadline"
                and finding.match_method == "deterministic"
                and not finding.field_changes
                and len(evidence) == 2
                and all(item.extraction_method == "native" for item in evidence)
                and len({item.document_id for item in evidence}) == 1
                and len({item.page for item in evidence}) == 1,
                "Contradiction must have native support from one PDF page",
            )
            first_dates = date_tokens(evidence[0].text)
            second_dates = date_tokens(evidence[1].text)
            _require(
                len(first_dates) == 1 and len(second_dates) == 1
                and first_dates[0].canonical is not None
                and second_dates[0].canonical is not None
                and first_dates[0].canonical != second_dates[0].canonical
                and category_for(evidence[0].text) == "deadline"
                and category_for(evidence[1].text) == "deadline"
                and anchor(evidence[0].text, "deadline") == anchor(evidence[1].text, "deadline"),
                "Contradiction must quote distinct parsed dates under the same label",
            )
        else:
            _require(
                finding.original is not None and finding.revised is not None,
                "Related passages must include both PDF sources",
            )

        if finding.status == "missing_information":
            _require(finding.similarity == 0, "Unmatched statement has fake similarity")
        elif finding.status == "contradiction":
            _require(finding.similarity == 1, "Contradiction has fake similarity")

        if finding.status == "confirmed_change":
            _require(
                finding.match_method == "deterministic"
                and finding.original is not None
                and finding.revised is not None
                and finding.original.extraction_method == "native"
                and finding.revised.extraction_method == "native",
                "A confirmed text change cannot depend on OCR or model inference",
            )
            _require(
                normalize(finding.original.text) != normalize(finding.revised.text),
                "Confirmed change cannot cite identical source wording",
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

        # No need to independently open untrusted PDF bytes in the API.
        # Recalculate structured values from each already-sourced passage;
        # arbitrary worker output cannot turn a possible pairing into a certain field delta.
        if (
            finding.status in ("confirmed_change", "possible_change")
            and finding.match_method == "deterministic"
        ):
            _require(
                finding.category == category_for(finding.original.text)
                and finding.category == category_for(finding.revised.text),
                "Deterministic finding category contradicts its source quotation",
            )
            old_context = anchor(finding.original.text, finding.category)
            new_context = anchor(finding.revised.text, finding.category)
            if finding.status == "confirmed_change":
                _require(
                    old_context == new_context,
                    "Confirmed change requires matching source context",
                )
            expected_similarity = round(context_similarity(old_context, new_context), 3)
            _require(
                finding.similarity == expected_similarity,
                "Reported text similarity does not match its quotations",
            )
            expected = field_changes(
                finding.original.text, finding.revised.text,
                category=finding.category,
                pairing_confirmed=finding.status == "confirmed_change",
            )
            _require(
                [item.model_dump() for item in finding.field_changes]
                == [item.model_dump() for item in expected],
                "Structured field claims do not match the source quotations",
            )

    findings_by_id = {finding.id: finding for finding in report.findings}
    checklist_ids: set[str] = set()
    for item in report.checklist:
        _require(item.finding_id in finding_ids, "Checklist references a missing finding")
        _require(item.finding_id not in checklist_ids, "Duplicate review checklist entry")
        checklist_ids.add(item.finding_id)
        _require(item.requires_human_verification, "Human review was disabled")
        referenced = findings_by_id[item.finding_id]
        _require(
            referenced.category in HINDI_CATEGORY,
            "Review task unexpectedly references an uncategorized finding",
        )
        expected_review = review_messages(
            referenced.category,
            semantic=referenced.match_method == "semantic_proposal",
        )
        _require(
            (item.description_en, item.description_hi) == expected_review,
            "Human review checklist text was altered",
        )

    required_review_ids = {
        finding.id for finding in report.findings
        if finding.category in {"deadline", "fee", "eligibility", "time", "instruction"}
    }
    _require(
        checklist_ids == required_review_ids,
        "Review checklist is missing consequential findings",
    )

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

    _require(
        len(report.warnings) <= 6 * MAX_PAGES + 12,
        "Worker report includes excessive warning messages",
    )
    _require(
        all(
            warning_supported(
                warning, summaries,
                ocr_requested=ocr_requested,
                semantic_requested=semantic_requested,
                text_coverage=coverage,
            )
            for warning in report.warnings
        ),
        "Worker warning text is not supported by the verification policy",
    )
