import { expect, test } from '@playwright/test';
import { buildIndex, type Passage } from '../src/pdfChatCore';
import { parseReference, searchReference } from '../src/pdfChatEvidenceExplorer';
import { followSourceReference, referencePage, sourceReferences, MAX_SOURCE_REFERENCES } from '../src/pdfChatReferenceReview';

function row(text: string, page = 1, ordinal = 1, role: Passage['role'] = 'original'): Passage {
  return { text, page, ordinal, role };
}
const start = row('Eligibility: See Clause 4.2(a).');
const lines = [
  start,
  row('See Clause 4.2(a) for details.', 1, 2),
  row('Clause 4.2(a): Residence certificate required.', 3),
  row('Clause 4.2(a): Different printed statement.', 4),
  row('Clause 4.2(b): Other condition.', 3, 2),
  row('Clause 4.20: Other section.', 5),
  row('Clause 4.2(a): Revised condition.', 2, 1, 'revised'),
];
test('sentence-final printed references preserve exact nested identifiers', () => {
  expect(sourceReferences(start)).toEqual({ references: [{
    reference: { kind: 'clause', identifier: '4.2(a)' }, printed: 'Clause 4.2(a)', atStart: false,
  }], total: 1 });
  expect(() => parseReference('Clause 4.2.')).toThrow();
  const index = buildIndex([row('See Clause 4.2.'), row('Clause 4.20: Other', 2), row('Clause 4.2(b): Other', 3)]);
  expect(searchReference(index, { scope: 'original' }, parseReference('Clause 4.2')).hits).toHaveLength(1);
});
test('reference review excludes self and other sources, prioritizes leading references', () => {
  const review = followSourceReference(buildIndex(lines), start, parseReference('Clause 4.2(a)'));
  expect(review.hits.map(hit => hit.source)).toEqual([lines[2], lines[3], lines[1]]);
  expect(review.samePage).toBe(1);
  expect(review.otherPages).toBe(2);
  expect(review.startsWithReference).toBe(2);
});
test('source references deduplicate repeated mentions and preserve first spelling', () => {
  const source = row('Clause 1: see clause 1 and Section 2. See SECTION 2.');
  const result = sourceReferences(source);
  expect(result.references.map(ref => [ref.printed, ref.atStart])).toEqual([
    ['Clause 1', true], ['Section 2', false],
  ]);
});
test('source references have explicit visible cap', () => {
  const result = sourceReferences(row(Array.from({ length: 10 }, (_, i) => 'Clause ' + (i + 1)).join('; ')));
  expect(result.total).toBe(10);
  expect(result.references).toHaveLength(MAX_SOURCE_REFERENCES);
});
test('foreign fragment, modified text and unprinted reference fail closed', () => {
  const index = buildIndex(lines);
  const ref = parseReference('Clause 4.2(a)');
  expect(() => followSourceReference(index, { ...start, page: 80 }, ref)).toThrow();
  expect(() => followSourceReference(index, { ...start, text: 'See Clause 4.2(a).' }, ref)).toThrow();
  expect(() => followSourceReference(index, start, parseReference('Clause 4.2(b)'))).toThrow();
});
test('pagination preserves each distinct reference hit with no implicit expansion', () => {
  const others = Array.from({ length: 17 }, (_, i) => row('Clause 4.2(a): ' + i, i + 2));
  const review = followSourceReference(buildIndex([start, ...others]), start, parseReference('Clause 4.2(a)'));
  expect(referencePage(review, 1).hits.map(hit => hit.source)).toEqual(others.slice(0, 8));
  expect(referencePage(review, 3).hits.map(hit => hit.source)).toEqual(others.slice(16));
  expect(() => referencePage(review, 4)).toThrow();
});
test('unsupported malformed reference suffixes do not match a parent identifier', () => {
  const rows = ['Clause 4.2.3', 'Clause 4.2..', 'Clause 4.2(a', 'Clause 4.2abc', 'Clause 4.2-5'].map((s,i) => row(s,i+1));
  expect(searchReference(buildIndex(rows), { scope: 'original' }, parseReference('Clause 4.2')).hits).toHaveLength(0);
});
