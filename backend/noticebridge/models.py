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


class ExtractedLine(BaseModel):
    text: str
    evidence: Evidence


class DocumentSummary(BaseModel):
    id: Literal["original", "revised"]
    filename: str
    page_count: int
    line_count: int
    has_extractable_text: bool


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
    authority_verified: bool = False


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
    verification_policy: str = (
        "Uploaded order does not establish authority. Verify consequential claims "
        "against the issuing organization's official publications."
    )
