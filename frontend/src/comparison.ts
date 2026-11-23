export type Language = 'en' | 'hi';
export type DocumentRole = 'original' | 'revised';

export type Evidence = {
  document_id: DocumentRole;
  filename: string;
  page: number;
  text: string;
  bbox: [number, number, number, number];
  extraction_method: 'native' | 'ocr';
  page_width: number;
  page_height: number;
  page_rotation: 0 | 90 | 180 | 270;
};

type ParsedValue = {
  kind: 'date' | 'amount';
  raw: string;
  canonical: string | null;
  confidence: 'parsed' | 'ambiguous' | 'invalid';
};

export type ValueChange = {
  kind: ParsedValue['kind'];
  original: ParsedValue;
  revised: ParsedValue;
  outcome: 'changed' | 'same_value' | 'uncertain';
};

export type FindingCategory = 'deadline' | 'eligibility' | 'fee' | 'time' | 'instruction' | 'general';
export type Finding = {
  id: string;
  status: 'confirmed_change' | 'possible_change' | 'contradiction' | 'missing_information';
  category: FindingCategory;
  summary_en: string;
  summary_hi: string;
  original: Evidence | null;
  revised: Evidence | null;
  supporting_evidence: Evidence[];
  similarity: number;
  match_method: 'deterministic' | 'semantic_proposal';
  authority_verified: boolean;
  field_changes: ValueChange[];
};

type ChecklistItem = {
  description_en: string;
  description_hi: string;
  finding_id: string;
  requires_human_verification: boolean;
};

type DocumentSummary = {
  id: DocumentRole;
  filename: string;
  page_count: number;
  line_count: number;
  has_extractable_text: boolean;
  sha256: string;
  ocr_page_count: number;
  ocr_pages?: number[];
  ocr_override_pages?: number[];
  pages_with_text: number;
  pages_without_text: number[];
};

export type Report = {
  documents: DocumentSummary[];
  findings: Finding[];
  checklist: ChecklistItem[];
  warnings: string[];
  verification_policy: string;
  text_coverage: 'all_pages_have_text' | 'partial' | 'inconclusive';
  fuzzy_matching_limited: boolean;
  semantic_assistance: 'not_requested' | 'no_candidates' | 'unavailable' | 'no_verified_pairs' | 'proposals_added';
};
