"""Public API types; all evidence coordinates refer to a real PDF page."""

from typing import Literal

from pydantic import BaseModel, Field

FindingStatus = Literal[
    "confirmed_change", "possible_change", "contradiction", "missing_information"
]


class Evidence(BaseModel):
    document_id: Literal["original", "revised"]
    filename: str
    page: int = Field(ge=1)
    text: str
    bbox: tuple[float, float, float, float]
    extraction_method: Literal["native", "ocr"] = "native"
    page_width: float = Field(gt=0)
    page_height: float = Field(gt=0)
    page_rotation: Literal[0, 90, 180, 270]


class ExtractedLine(BaseModel):
    text: str
    evidence: Evidence


class DocumentSummary(BaseModel):
    id: Literal["original", "revised"]
    filename: str
    page_count: int
    line_count: int
    has_extractable_text: bool
    sha256: str
    ocr_page_count: int = Field(default=0, ge=0)
    pages_with_text: int = Field(default=0, ge=0)
    pages_without_text: list[int] = Field(default_factory=list)


class ParsedValue(BaseModel):
    kind: Literal["date", "amount"]
    raw: str
    canonical: str | None = None
    confidence: Literal["parsed", "ambiguous", "invalid"]


class ValueChange(BaseModel):
    kind: Literal["date", "amount"]
    original: ParsedValue
    revised: ParsedValue
    outcome: Literal["changed", "same_value", "uncertain"]


class Finding(BaseModel):
    id: str
    status: FindingStatus
    category: Literal["deadline", "eligibility", "fee", "time", "instruction", "general"]
    summary_en: str
    summary_hi: str
    original: Evidence | None = None
    revised: Evidence | None = None
    supporting_evidence: list[Evidence] = Field(default_factory=list)
    similarity: float = Field(ge=0, le=1)
    match_method: Literal["deterministic", "semantic_proposal"] = "deterministic"
    authority_verified: bool = False
    field_changes: list[ValueChange] = Field(default_factory=list)


class ChecklistItem(BaseModel):
    description_en: str
    description_hi: str
    finding_id: str
    requires_human_verification: bool = True


class ComparisonReport(BaseModel):
    documents: list[DocumentSummary]
    findings: list[Finding]
    checklist: list[ChecklistItem]
    warnings: list[str]
    text_coverage: Literal["all_pages_have_text", "partial", "inconclusive"] = "inconclusive"
    fuzzy_matching_limited: bool = False
    semantic_assistance: Literal[
        "not_requested", "no_candidates", "unavailable", "no_verified_pairs",
        "proposals_added"
    ] = "not_requested"
    verification_policy: str = (
        "Uploaded order does not establish authority. Verify consequential claims "
        "against the issuing organization's official publications."
    )
