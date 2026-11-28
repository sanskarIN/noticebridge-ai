import { expect, test } from '@playwright/test';
import { buildIndex, type Passage } from '../src/pdfChatCore';
import { buildRequirementIndex, findRequirements, requirementCues, requirementIntent, requirementPage,
  MAX_REQUIREMENT_CUES, REQUIREMENT_PAGE_SIZE } from '../src/pdfChatRequirements';

function row(text: string, page = 1, ordinal = 1, role: Passage['role'] = 'original'): Passage {
  return { text, page, ordinal, role };
}
const rows = [
  row('Applicants must submit a certificate.'),
  row('Applicants must not submit duplicate forms.', 1, 2),
  row('Fee payment is required unless exempt.', 2),
  row('Candidates may apply online.', 2, 2),
  row('Applicants should retain a receipt.', 3),
  row('The examination is on 15 May 2026.', 3, 2),
  row('Applicants must submit a certificate.', 1, 1, 'revised'),
  row('Applicants must submit two certificates.', 2, 1, 'revised'),
  row('A receipt is not required.', 2, 2, 'revised'),
];
const idx = buildIndex(rows);
const req = buildRequirementIndex(idx);
const attached = ['original', 'revised'] as const;

test('longest cue suppresses nested contradictory marker', () => {
  const result = requirementCues('Must not apply; not required; not permitted; may not attend.');
  expect(result.cues.map(cue => [cue.kind, cue.text])).toEqual([
    ['prohibited', 'Must not'], ['exception', 'not required'],
    ['prohibited', 'not permitted'], ['prohibited', 'may not'],
  ]);
  expect(result.kinds).toEqual(['prohibited', 'exception']);
});
test('multiple distinct cues remain independent', () => {
  const result = requirementCues('Applicants must provide proof unless exempt, and should retain a copy.');
  expect(result.kinds).toEqual(['mandatory', 'exception', 'recommendation']);
  expect(result.cues.map(cue => cue.text)).toEqual(['must', 'unless', 'exempt', 'should']);
});
test('marker offsets preserve Unicode and original spelling', () => {
  const text = '😀 Applicants MUST submit.';
  const cue = requirementCues(text).cues[0];
  expect(cue).toEqual({ start: 14, end: 18, kind: 'mandatory', text: 'MUST' });
  expect(text.slice(cue.start, cue.end)).toBe('MUST');
});
test('bare month name, substring and unsupported modal do not activate a category', () => {
  for (const text of ['May 2026', 'mustard', 'unrequired', 'optionalities', 'émust', 'must2', 'may be', 'shoulder']) {
    expect(requirementCues(text).total).toBe(0);
  }
});
test('display cap does not erase a later cue category', () => {
  const result = requirementCues('must '.repeat(MAX_REQUIREMENT_CUES + 4) + 'unless exempt');
  expect(result.cues).toHaveLength(MAX_REQUIREMENT_CUES);
  expect(result.total).toBe(MAX_REQUIREMENT_CUES + 6);
  expect(result.kinds).toEqual(['mandatory', 'exception']);
});
test('role and page filtering never crosses scope', () => {
  const result = findRequirements(idx, req, { scope: 'revised', page: 2, kind: 'mandatory' }, attached);
  expect(result.hits.map(hit => hit.source)).toEqual([rows[7]]);
  expect(result.countByRole).toEqual({ original: 0, revised: 1 });
  expect(result.hits[0].exactOtherOccurrences).toBeNull();
  expect(result.scopedFragments).toBe(2);
});
test('multiple cue categories may overlap but each fragment is counted once', () => {
  const result = findRequirements(idx, req, { scope: 'original', page: 2, kind: 'all' }, attached);
  expect(result.hits).toHaveLength(2);
  expect(result.countByKind).toEqual({ mandatory: 1, prohibited: 0, exception: 1, permission: 1, recommendation: 0 });
});
test('exact counterpart wording count is not fuzzy and only available in explicit both scope', () => {
  const result = findRequirements(idx, req, { scope: 'both', kind: 'mandatory' }, attached);
  expect(result.hits.find(hit => hit.source === rows[0])?.exactOtherOccurrences).toBe(1);
  expect(result.hits.find(hit => hit.source === rows[7])?.exactOtherOccurrences).toBe(0);
  const missing = findRequirements(idx, req, { scope: 'both', kind: 'mandatory' }, ['original']);
  expect(missing.hits.every(hit => hit.exactOtherOccurrences === null)).toBe(true);
});
test('same physical page filter applies to counterpart wording lookup', () => {
  const rows = [row('Applicants must apply.'), row('Applicants must apply.', 2, 1, 'revised')];
  const index = buildIndex(rows), requirements = buildRequirementIndex(index);
  const result = findRequirements(index, requirements, { scope: 'both', page: 1, kind: 'all' }, attached);
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0].exactOtherOccurrences).toBe(0);
});
test('literal keyword filtering is not regex or cross-fragment search', () => {
  const result = findRequirements(idx, req, { scope: 'both', kind: 'all', keyword: 'CERTIFICATE' }, attached);
  expect(result.hits.map(hit => hit.source)).toEqual([rows[0], rows[6], rows[7]]);
  expect(findRequirements(idx, req, { scope: 'both', kind: 'all', keyword: 'cert.*' }, attached).hits).toEqual([]);
});
test('pagination preserves all eligible identities and stable order', () => {
  const rows = Array.from({ length: 29 }, (_, i) => row('Applicants must provide form ' + i, i + 1));
  const index = buildIndex(rows);
  const result = findRequirements(index, buildRequirementIndex(index), { scope: 'original', kind: 'all' }, ['original']);
  const pages = Math.ceil(rows.length / REQUIREMENT_PAGE_SIZE);
  expect(Array.from({ length: pages }, (_, i) => requirementPage(result, i + 1).hits.map(hit => hit.source)).flat()).toEqual(rows);
  expect(() => requirementPage(result, pages + 1)).toThrow();
});
test('invalid scopes, page bounds and excessive keywords are rejected', () => {
  for (const page of [0, 81, 1.5, NaN]) {
    expect(() => findRequirements(idx, req, { scope: 'both', page, kind: 'all' }, attached)).toThrow();
  }
  expect(() => findRequirements(idx, req, { scope: 'both', kind: 'all', keyword: 'x'.repeat(121) }, attached)).toThrow();
});
for (const [question, kind] of [
  ['What are the requirements?', 'all'], ['What must I do?', 'all'],
  ['List mandatory conditions', 'mandatory'], ['What is not permitted?', 'prohibited'],
  ['What must we not do?', 'prohibited'], ['Show exemptions', 'exception'],
  ['What is optional?', 'permission'], ['What is recommended?', 'recommendation'],
] as const) {
  test('explicit broad requirement intent: ' + question, () => expect(requirementIntent(question)).toBe(kind));
}
for (const question of ['What are requirements for staff?', 'What must I do to apply online?',
  'Am I eligible?', 'What documents are required?', 'What is the exception to clause 3?']) {
  test('does not discard scoped subject: ' + question, () => expect(requirementIntent(question)).toBeNull());
}
