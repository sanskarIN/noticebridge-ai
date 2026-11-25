import { expect, test } from '@playwright/test';
import { answerQuestion, buildIndex, knownQuestionField, queryTerms, type Passage } from '../src/pdfChatCore';
import { buildNoticeOverview, extractKnownField, fieldDefinitions } from '../src/pdfChatOverview';
import { comparePrintedValues, groupPrintedValues } from '../src/pdfChatInsights';

function row(text: string, ordinal = 1, role: Passage['role'] = 'original', page = 1): Passage {
  return { text, ordinal, role, page };
}
const original = row('Last date to apply: 19 December 2026');
const revised = row('Application closing date: 13 December 2026', 1, 'revised');
const fees = row('Application fee: Rs. 500', 2);
const exam = row('Examination fee: Rs. 750', 3);

test('recognizes explicit labels without changing their printed wording', () => {
  const field = extractKnownField(original);
  expect(field?.definition.id).toBe('application_deadline');
  expect(field?.label).toBe('Last date to apply');
  expect(field?.value).toBe('19 December 2026');
  expect(field?.source).toBe(original);
});
test('all declared field aliases resolve uniquely in the overview', () => {
  const seen = new Set<string>();
  for (const field of fieldDefinitions) {
    for (const alias of field.aliases) {
      expect(seen.has(alias)).toBe(false);
      seen.add(alias);
      expect(extractKnownField(row(alias + ': Sample value'))?.definition.id).toBe(field.id);
    }
  }
});
for (const value of [
  'Application fee', 'Application fee:', 'Application fee:   ',
  'General application fee: Rs. 500', 'Application fee for staff: Rs. 50',
  'Do not pay application fee: Rs. 500',
  'Application fee: Rs. 500; Examination fee: Rs. 750',
  'Application fee: ' + 'x'.repeat(301),
]) {
  test('does not promote ambiguous or unsupported label: ' + value.slice(0, 65), () => {
    expect(extractKnownField(row(value))).toBeNull();
  });
}
test('keeps different field categories separate', () => {
  const fields = buildNoticeOverview(buildIndex([original, revised, fees, exam]));
  expect(fields.map(field => field.definition.id)).toEqual([
    'application_deadline', 'application_fee', 'exam_fee',
  ]);
  const deadline = fields[0];
  expect(deadline.outcome).toBe('different_printed_text');
  expect(deadline.original.values[0].citations[0].source).toBe(original);
  expect(deadline.revised.values[0].citations[0].source).toBe(revised);
  expect(fields[1].outcome).toBe('one_source_only');
});
test('identical printed values across label aliases are not asserted as verified facts', () => {
  const updated = row('Application charges: Rs. 500', 1, 'revised');
  expect(buildNoticeOverview(buildIndex([fees, updated]))[0].outcome).toBe('same_printed_text');
});
test('different numerical formatting remains different printed wording', () => {
  const updated = row('Application fee: INR 500', 1, 'revised');
  expect(buildNoticeOverview(buildIndex([fees, updated]))[0].outcome).toBe('different_printed_text');
});
test('all distinct values are counted before limiting the display', () => {
  const source = Array.from({ length: 7 }, (_, i) => row('Application fee: Rs. ' + (100 + i), i + 1));
  const field = buildNoticeOverview(buildIndex(source))[0];
  expect(field.original.distinctValues).toBe(7);
  expect(field.original.values).toHaveLength(4);
  expect(field.outcome).toBe('multiple_printed_values');
});
test('repeated values retain bounded provenance and full occurrence count', () => {
  const source = Array.from({ length: 6 }, (_, i) => row('Application fee: Rs. 500', 1, 'original', i + 1));
  const field = buildNoticeOverview(buildIndex([...source, source[0]]))[0];
  expect(field.original.distinctValues).toBe(1);
  expect(field.original.values[0].occurrences).toBe(6);
  expect(field.original.values[0].citations.map(item => item.source.page)).toEqual([1, 2, 3]);
});
test('absence of recognized labels creates no invented fields', () => {
  expect(buildNoticeOverview(buildIndex([row('Fictional text without field labels')]))).toEqual([]);
  expect(buildNoticeOverview(buildIndex([]))).toEqual([]);
});
test('exact bare field query finds alternative printed labels', () => {
  const result = answerQuestion(buildIndex([original, revised]), 'Application deadline?', 'both');
  expect(result.citations).toEqual([original, revised]);
  expect(result.printedFields).toEqual([
    { citation: 1, label: 'Last date to apply', value: '19 December 2026' },
    { citation: 2, label: 'Application closing date', value: '13 December 2026' },
  ]);
  expect(comparePrintedValues(groupPrintedValues(result))[0].outcome).toBe('different_printed_text');
});
test('additional qualifiers do not disappear in field matching', () => {
  const source = buildIndex([original, revised, fees]);
  for (const question of ['Application fee for staff?', 'Application deadline in January?', 'Application fee refund?']) {
    expect(knownQuestionField(queryTerms(question))).toBeNull();
    expect(answerQuestion(source, question, 'both').kind).toBe('insufficient');
  }
});
test('generic fee query does not arbitrarily select one field category', () => {
  expect(knownQuestionField(queryTerms('fee'))).toBeNull();
  const result = answerQuestion(buildIndex([fees, exam]), 'fee', 'original');
  expect(result.citations).toHaveLength(2);
});
test('ambiguous multi-field lines may be inspected but are not promoted to a compact value', () => {
  const fragment = row('Application fee: Rs. 500; Examination fee: Rs. 750');
  const result = answerQuestion(buildIndex([fragment]), 'Application fee', 'original');
  expect(result.citations).toEqual([fragment]);
  expect(result.printedFields).toEqual([]);
});
