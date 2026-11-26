import { expect, test } from '@playwright/test';
import { buildOutline, compareOutlineSections, detectOutlineHeading, filterOutline,
  findOutlineSection, outlinePage, searchSectionFragments, MAX_SECTION_COMPARISON_FRAGMENTS,
  type OutlineFilter } from '../src/pdfChatStructure';
import type { Corpus, Passage, Role } from '../src/pdfChatCore';

function row(role: Role, page: number, ordinal: number, text: string): Passage {
  return { role, page, ordinal, text };
}
const o = (page: number, ordinal: number, text: string) => row('original', page, ordinal, text);
const r = (page: number, ordinal: number, text: string) => row('revised', page, ordinal, text);
const original = [o(1, 1, 'Fictional notice'), o(1, 2, 'Section 1: Eligibility'),
  o(1, 3, 'Class 12 required'), o(1, 5, 'Residence certificate required'),
  o(3, 1, 'Contact the district office'), o(3, 2, 'Section 2: Payment'),
  o(3, 3, 'Application fee: INR 500'), o(3, 4, 'Section 2: Payment'),
  o(3, 5, 'Fee waiver may apply')];
const revised = [r(1, 1, 'Section 1: Eligibility'), r(1, 2, 'Class 12 required'),
  r(1, 3, 'Residence certificate required'), r(1, 4, 'Contact the district office'),
  r(2, 1, 'Section 2: Payment'), r(2, 2, 'Application fee: INR 350')];
function corpus(passages: Passage[], pageCount: number, missingPages: number[] = []): Corpus {
  return { passages, pageCount, processedPages: pageCount, missingPages, limitedPages: [], limited: false };
}
const outline = buildOutline({ original: corpus(original, 3, [2]), revised: corpus(revised, 2) });
const all: OutlineFilter = { scope: 'both', keyword: '', kind: 'all', pairedOnly: false };

test('recognizes explicit reference markers and bounded standalone headings', () => {
  expect(detectOutlineHeading('Section 4.2(a): Payment')).toMatchObject({ kind: 'reference', key: 'ref:section:4.2(a)', title: 'Payment' });
  expect(detectOutlineHeading('Annexure A')).toMatchObject({ kind: 'reference', key: 'ref:annexure:a' });
  expect(detectOutlineHeading('2. IMPORTANT DATES')).toMatchObject({ kind: 'numbered', key: 'number:2' });
  expect(detectOutlineHeading('Eligibility criteria:')).toMatchObject({ kind: 'named' });
  expect(detectOutlineHeading('Application fee')).toMatchObject({ kind: 'named' });
});
test('does not treat running references, printed values or list sentences as headings', () => {
  for (const value of ['Clause 3 applies to all applicants', 'Refer to Section 2: Payment',
    'Section 3: Applicants must apply', 'Application fee: INR 500', '1. Submit the form',
    '12.12.2026: Last day', 'Payment must be made', 'Section 3.4.5.6.7.8.9: Payment',
    'Section 4: ' + 'x'.repeat(181)]) expect(detectOutlineHeading(value)).toBeNull();
});
test('outline partitions exact native fragment identities, including repeated markers', () => {
  expect(outline.original?.beforeFirst).toEqual([original[0]]);
  expect(outline.original?.sections.map(section => section.source)).toEqual([original[1], original[5], original[7]]);
  expect(outline.original?.sections[0].fragments).toEqual(original.slice(2, 5));
  expect(outline.original?.sections[0].ordinalGaps).toBe(1);
  expect(outline.original?.sections[0].uncertainPages).toEqual([2]);
  expect(outline.original?.sections[0].firstPage).toBe(1);
  expect(outline.original?.sections[0].lastPage).toBe(3);
  expect(outline.original?.sections.flatMap(section => [section.source, ...section.fragments]))
    .toEqual(original.slice(1));
});
test('filters preserve role and exact marker identity and disclose duplicates', () => {
  const matches = filterOutline(outline, { ...all, scope: 'revised', keyword: 'payment', pairedOnly: true });
  expect(matches).toHaveLength(1);
  expect(matches[0].sameKeyOther.map(section => section.source)).toEqual([original[5], original[7]]);
  expect(matches[0].repeatedHere).toBe(1);
  expect(filterOutline(outline, { ...all, scope: 'original', keyword: 'payment' }).map(row => row.repeatedHere))
    .toEqual([2, 2]);
  expect(filterOutline(outline, { ...all, kind: 'named' })).toEqual([]);
});
test('section literal filter cannot read adjacent sections or another source', () => {
  const section = findOutlineSection(outline, 'original:1:2');
  expect(searchSectionFragments(section, 'certificate')).toEqual([original[3]]);
  expect(searchSectionFragments(section, 'INR')).toEqual([]);
  expect(searchSectionFragments(section, '')).toEqual(original.slice(1, 5));
});
test('exact sequence alignment reports unpaired wording without replacing source evidence', () => {
  const result = compareOutlineSections(outline, 'original:3:2', 'revised:2:1');
  expect(result.same).toBe(1);
  expect(result.originalUnpaired).toBe(1);
  expect(result.revisedUnpaired).toBe(1);
  expect(result.rows).toEqual([
    { kind: 'same_wording', original: original[5], revised: revised[4] },
    { kind: 'original_unpaired', original: original[6] },
    { kind: 'revised_unpaired', revised: revised[5] },
  ]);
});
test('alignment retains page differences and flags missing text or ordinal gaps', () => {
  const result = compareOutlineSections(outline, 'original:1:2', 'revised:1:1');
  expect(result.same).toBe(4);
  expect(result.coverageLimited).toBe(true);
  expect(result.rows[3]).toMatchObject({ original: { page: 3 }, revised: { page: 1 } });
});
test('repeated wording stays visible and may have several alignments', () => {
  const a = [o(1, 1, 'Section 1: Test'), o(1, 2, 'same'), o(1, 3, 'same')];
  const b = [r(1, 1, 'Section 1: Test'), r(1, 2, 'same')];
  const result = compareOutlineSections(buildOutline({ original: corpus(a, 1), revised: corpus(b, 1) }),
    'original:1:1', 'revised:1:1');
  expect(result.repeatedText).toBe(true);
  expect(result.same).toBe(2);
  expect(result.originalUnpaired).toBe(1);
});
test('wrong roles, differing markers and unknown section IDs are rejected', () => {
  expect(() => compareOutlineSections(outline, 'original:1:2', 'revised:2:1')).toThrow();
  expect(() => compareOutlineSections(outline, 'revised:1:1', 'original:1:2')).toThrow();
  expect(() => findOutlineSection(outline, 'original:1:99')).toThrow();
});
test('large candidate span cannot trigger unbounded dynamic alignment', () => {
  const a = [o(1, 1, 'Section 1: Test'),
    ...Array.from({ length: MAX_SECTION_COMPARISON_FRAGMENTS }, (_, i) => o(1, i + 2, 'text ' + i))];
  const b = [r(1, 1, 'Section 1: Test')];
  expect(() => compareOutlineSections(buildOutline({ original: corpus(a, 1), revised: corpus(b, 1) }),
    'original:1:1', 'revised:1:1')).toThrow('bounded');
});
test('empty and image-only sources have no synthetic headings', () => {
  const empty = buildOutline({ original: corpus([], 1, [1]) });
  expect(empty.original?.sections).toEqual([]);
  expect(filterOutline(empty, all)).toEqual([]);
  expect(outlinePage([], 1)).toEqual({ items: [], pages: 1, first: 0, last: 0 });
});
test('duplicate source identities and cross-role source fragments are rejected', () => {
  expect(() => buildOutline({ original: corpus([original[0], original[0]], 1) })).toThrow();
  expect(() => buildOutline({ original: corpus([revised[0]], 1) })).toThrow();
});
test('pagination and filter bounds fail closed', () => {
  expect(() => outlinePage([1], 2)).toThrow();
  expect(() => outlinePage([1], 1, 1000)).toThrow();
  expect(() => filterOutline(outline, { ...all, keyword: 'x'.repeat(121) })).toThrow();
  expect(() => searchSectionFragments(outline.original!.sections[0], 'x'.repeat(121))).toThrow();
});
