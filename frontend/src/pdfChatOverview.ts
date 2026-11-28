/** Conservative extractive notice overview. No field value is invented. */
import type { Passage, Role, SearchIndex } from './pdfChatCore';

export const fieldDefinitions = [
  { id: 'application_deadline', label: 'Application deadline', aliases: [
    'application deadline', 'application last date', 'application closing date',
    'last date for application', 'last date for applications', 'last date to apply',
    'application due date', 'application cutoff date', 'application cut-off date',
  ], query: 'Application deadline' },
  { id: 'registration_deadline', label: 'Registration deadline', aliases: [
    'registration deadline', 'registration last date', 'registration closing date', 'last date for registration',
  ], query: 'Registration deadline' },
  { id: 'application_start', label: 'Application opening date', aliases: [
    'application start date', 'application opening date', 'application commencement date',
  ], query: 'Application start date' },
  { id: 'application_fee', label: 'Application fee', aliases: [
    'application fee', 'application fees', 'application charge', 'application charges',
  ], query: 'Application fee' },
  { id: 'exam_fee', label: 'Examination fee', aliases: [
    'exam fee', 'examination fee', 'exam fees', 'examination fees',
  ], query: 'Examination fee' },
  { id: 'registration_fee', label: 'Registration fee', aliases: [
    'registration fee', 'registration fees', 'registration charges',
  ], query: 'Registration fee' },
  { id: 'eligibility', label: 'Eligibility', aliases: [
    'eligibility', 'eligibility criteria', 'eligibility conditions',
    'educational qualification', 'educational qualifications',
  ], query: 'Eligibility' },
  { id: 'documents', label: 'Required documents', aliases: [
    'required documents', 'documents required', 'documents needed',
    'required certificates', 'certificates required',
  ], query: 'Required documents' },
  { id: 'exam_date', label: 'Examination date', aliases: ['exam date', 'examination date', 'date of examination'],
    query: 'Examination date' },
  { id: 'exam_time', label: 'Examination time', aliases: ['exam time', 'examination time', 'examination timing'],
    query: 'Examination time' },
  { id: 'interview_date', label: 'Interview date', aliases: ['interview date', 'date of interview'],
    query: 'Interview date' },
  { id: 'interview_time', label: 'Interview time', aliases: ['interview time', 'interview timing'],
    query: 'Interview time' },
  { id: 'interview_venue', label: 'Interview venue', aliases: ['interview venue', 'venue of interview', 'interview location'],
    query: 'Interview venue' },
  { id: 'reporting_time', label: 'Reporting time', aliases: ['reporting time', 'time of reporting'],
    query: 'Reporting time' },
  { id: 'contact_email', label: 'Contact email', aliases: ['contact email', 'contact e-mail', 'helpdesk email'],
    query: 'Contact email' },
  { id: 'registration_start', label: 'Registration opening date', aliases: [
    'registration opening date', 'registration start date', 'registration commencement date',
  ], query: 'Registration opening date' },
  { id: 'payment_deadline', label: 'Payment deadline', aliases: [
    'payment deadline', 'fee payment deadline', 'payment last date', 'last date for fee payment', 'last date to pay fee', 'payment due date',
  ], query: 'Payment deadline' },
  { id: 'correction_start', label: 'Correction window opening date', aliases: [
    'correction window opening date', 'correction window start date', 'application correction start date',
  ], query: 'Correction window opening date' },
  { id: 'correction_deadline', label: 'Correction window deadline', aliases: [
    'correction window deadline', 'correction window closing date', 'application correction deadline', 'last date for correction',
  ], query: 'Correction window deadline' },
  { id: 'admit_card_date', label: 'Admit card release date', aliases: [
    'admit card release date', 'admit card issue date', 'date of admit card release', 'hall ticket release date',
  ], query: 'Admit card release date' },
  { id: 'result_date', label: 'Result publication date', aliases: [
    'result publication date', 'result declaration date', 'result announcement date', 'date of result declaration',
  ], query: 'Result publication date' },
  { id: 'verification_date', label: 'Document verification date', aliases: [
    'document verification date', 'date of document verification',
  ], query: 'Document verification date' },
  { id: 'verification_time', label: 'Document verification time', aliases: [
    'document verification time', 'document verification timing', 'time of document verification',
  ], query: 'Document verification time' },
  { id: 'verification_venue', label: 'Document verification venue', aliases: [
    'document verification venue', 'venue of document verification', 'document verification location',
  ], query: 'Document verification venue' },
  { id: 'exam_venue', label: 'Examination venue', aliases: [
    'examination venue', 'exam venue', 'venue of examination', 'examination location', 'exam location',
  ], query: 'Examination venue' },
  { id: 'reporting_venue', label: 'Reporting venue', aliases: [
    'reporting venue', 'reporting location', 'venue for reporting',
  ], query: 'Reporting venue' },
  { id: 'application_method', label: 'Application method', aliases: [
    'application method', 'mode of application', 'application submission mode', 'application submission method',
  ], query: 'Application method' },
  { id: 'application_portal', label: 'Application portal', aliases: [
    'application portal', 'online application portal', 'application website', 'online application website',
  ], query: 'Application portal' },
  { id: 'payment_method', label: 'Payment method', aliases: [
    'payment method', 'mode of payment', 'fee payment method', 'fee payment mode',
  ], query: 'Payment method' },
  { id: 'contact_phone', label: 'Contact phone', aliases: [
    'contact phone', 'contact phone number', 'contact number', 'helpdesk phone', 'helpdesk number', 'helpline number',
  ], query: 'Contact phone' },
  { id: 'age_limit', label: 'Age limit', aliases: [
    'age limit', 'age limits', 'age requirement',
  ], query: 'Age limit' },
  { id: 'minimum_age', label: 'Minimum age', aliases: [
    'minimum age', 'lower age limit', 'minimum age requirement',
  ], query: 'Minimum age' },
  { id: 'maximum_age', label: 'Maximum age', aliases: [
    'maximum age', 'upper age limit', 'maximum age requirement',
  ], query: 'Maximum age' },
  { id: 'selection_process', label: 'Selection process', aliases: [
    'selection process', 'selection procedure', 'mode of selection',
  ], query: 'Selection process' },
  { id: 'vacancy_count', label: 'Number of vacancies', aliases: [
    'number of vacancies', 'total vacancies', 'vacancy count',
  ], query: 'Number of vacancies' },
] as const;
export type FieldId = typeof fieldDefinitions[number]['id'];
export type FieldDefinition = typeof fieldDefinitions[number];
export const MAX_FIELD_VALUES = 4;
export const MAX_VALUE_CITATIONS = 3;

function normalizeLabel(label: string): string {
  return label.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

const aliases = new Map<string, FieldDefinition>();
for (const definition of fieldDefinitions) {
  for (const alias of definition.aliases) aliases.set(alias, definition);
}
const embeddedLabel = new RegExp('(?:^|[^\\p{L}\\p{N}])(?:' + [...aliases.keys()].map(alias =>
  alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
).join('|') + ')\\s*:', 'u');

/** Exact, explicit printed label vocabulary (not a semantic guess). */
export function fieldForLabel(label: string): FieldDefinition | undefined {
  return aliases.get(normalizeLabel(label));
}

export type ExtractedField = {
  definition: FieldDefinition;
  label: string;
  value: string;
  source: Passage;
};

export function extractKnownField(passage: Passage): ExtractedField | null {
  const colon = passage.text.indexOf(':');
  if (colon < 1 || colon > 100) return null;
  const label = passage.text.slice(0, colon).trim();
  const value = passage.text.slice(colon + 1).trim();
  const definition = fieldForLabel(label);
  if (!definition || !value || value.length > 300) return null;
  // A single line containing a second recognized field is ambiguous.
  // Do not promote a partial substring as the value of the first field.
  if (embeddedLabel.test(normalizeLabel(value))) return null;
  return { definition, label, value, source: passage };
}

export type OverviewValue = {
  value: string;
  occurrences: number;
  citations: ExtractedField[];
};
export type OverviewSide = {
  role: Role;
  distinctValues: number;
  values: OverviewValue[];
};
export type OverviewField = {
  definition: FieldDefinition;
  original: OverviewSide;
  revised: OverviewSide;
  outcome: 'one_source_only' | 'same_printed_text' | 'different_printed_text' | 'multiple_printed_values';
};

function collectSide(fields: ExtractedField[], role: Role): OverviewSide {
  const byValue = new Map<string, OverviewValue>();
  for (const field of fields) {
    if (field.source.role !== role) continue;
    const existing = byValue.get(field.value);
    if (existing) {
      existing.occurrences++;
      if (existing.citations.length < MAX_VALUE_CITATIONS) existing.citations.push(field);
    } else {
      byValue.set(field.value, { value: field.value, occurrences: 1, citations: [field] });
    }
  }
  return { role, distinctValues: byValue.size, values: [...byValue.values()].slice(0, MAX_FIELD_VALUES) };
}

export function buildNoticeOverview(index: SearchIndex): OverviewField[] {
  const byField = new Map<FieldId, ExtractedField[]>();
  // Sort a copy; the search index is immutable by convention.
  const sorted = [...index.rows].sort((a, b) =>
    a.passage.page - b.passage.page || a.passage.ordinal - b.passage.ordinal);
  const seen = new Set<string>();
  for (const row of sorted) {
    const field = row.field;
    if (!field) continue;
    const id = field.source.role + ':' + field.source.page + ':' + field.source.ordinal;
    if (seen.has(id)) continue;
    seen.add(id);
    const group = byField.get(field.definition.id) ?? [];
    group.push(field);
    byField.set(field.definition.id, group);
  }
  return fieldDefinitions.flatMap(definition => {
    const fields = byField.get(definition.id);
    if (!fields?.length) return [];
    const original = collectSide(fields, 'original');
    const revised = collectSide(fields, 'revised');
    const outcome = original.distinctValues > 1 || revised.distinctValues > 1 ? 'multiple_printed_values'
      : !original.distinctValues || !revised.distinctValues ? 'one_source_only'
      : original.values[0].value === revised.values[0].value ? 'same_printed_text' : 'different_printed_text';
    return [{ definition, original, revised, outcome }];
  });
}
