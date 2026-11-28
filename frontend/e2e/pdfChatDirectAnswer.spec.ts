import { expect, test } from '@playwright/test';
import { answerQuestion, buildIndex, type Passage } from '../src/pdfChatCore';
import { answerScopedQuestions } from '../src/pdfChatInsights';
import { directFieldAnswer } from '../src/pdfChatDirectAnswer';

function row(text: string, ordinal: number, role: Passage['role'] = 'original', page = 1): Passage {
  return { text, ordinal, role, page };
}
const original = row('Last date to apply: 19 December 2026', 1);
const revised = row('Application closing date: 13 December 2026', 1, 'revised');
const fee = row('Application fee: Rs. 500', 2);
const revisedFee = row('Application charges: Rs. 350', 2, 'revised');
const rows = [original, revised, fee, revisedFee];
const index = buildIndex(rows);

test('direct summary retains exact source labels and values', () => {
  const result = directFieldAnswer(index, answerQuestion(index, 'Application deadline', 'both'));
  expect(result?.field.id).toBe('application_deadline');
  expect(result?.comparison).toBe('different_text');
  expect(result?.sides[0].values[0].sources[0].source).toBe(original);
  expect(result?.sides[1].values[0].sources[0].source).toBe(revised);
  expect(result?.sides[0].values[0].value).toBe('19 December 2026');
});
test('same printed value text is not normalized into a factual equivalence', () => {
  const same = buildIndex([fee, row('Application charges: Rs. 500', 1, 'revised')]);
  expect(directFieldAnswer(same, answerQuestion(same, 'Application fee', 'both'))?.comparison).toBe('same_text');
  const different = buildIndex([fee, row('Application charges: INR 500', 1, 'revised')]);
  expect(directFieldAnswer(different, answerQuestion(different, 'Application fee', 'both'))?.comparison).toBe('different_text');
});
test('scope and physical page are retained', () => {
  const extra = row('Application fee: Rs. 999', 1, 'original', 2);
  const idx = buildIndex([...rows, extra]);
  const answer = answerScopedQuestions(idx, 'Application fee in original notice on page 2?', 'auto', ['original', 'revised'])[0];
  const result = directFieldAnswer(idx, answer);
  expect(result?.sides).toHaveLength(1);
  expect(result?.sides[0].role).toBe('original');
  expect(result?.sides[0].values.map(v => v.value)).toEqual(['Rs. 999']);
});
test('missing value in a requested source is not treated as removal', () => {
  const idx = buildIndex([fee, revised]);
  const result = directFieldAnswer(idx, answerQuestion(idx, 'Application fee', 'both'));
  expect(result?.comparison).toBe('missing_value');
  expect(result?.sides[1].distinctValues).toBe(0);
});
test('no direct summary for qualified and unsupported questions', () => {
  for (const question of ['Application fee for rural applicants', 'Application fee refund', 'Is application fee waived?', 'fee', 'What is not the application fee?']) {
    expect(directFieldAnswer(index, answerQuestion(index, question, 'both'))).toBeNull();
  }
});
test('all distinct values counted before display limits and retrieval ranking', () => {
  const many = Array.from({ length: 7 }, (_, i) => row('Application fee: Rs. ' + (500 + i), i + 1));
  const idx = buildIndex(many);
  const answer = answerQuestion(idx, 'Application fee', 'original');
  expect(answer.citations).toHaveLength(4);
  const result = directFieldAnswer(idx, answer);
  expect(result?.comparison).toBe('multiple_values');
  expect(result?.sides[0].distinctValues).toBe(7);
  expect(result?.sides[0].values).toHaveLength(4);
});
test('duplicate printed values preserve all occurrence counts and bounded references', () => {
  const many = Array.from({ length: 6 }, (_, i) => row('Application fee: Rs. 500', 1, 'original', i + 1));
  const idx = buildIndex([...many, many[0]]);
  const result = directFieldAnswer(idx, answerQuestion(idx, 'Application fee', 'original'));
  expect(result?.sides[0].distinctValues).toBe(1);
  expect(result?.sides[0].values[0].occurrences).toBe(6);
  expect(result?.sides[0].values[0].sources).toHaveLength(3);
});
test('other relevant passages remain outside the direct value summary', () => {
  const condition = row('Application fee is waived for eligible applicants.', 3);
  const idx = buildIndex([fee, condition]);
  const result = directFieldAnswer(idx, answerQuestion(idx, 'Application fee', 'original'));
  expect(result?.sides[0].otherMatchingPassages).toBe(1);
  expect(result?.sides[0].values[0].value).toBe('Rs. 500');
});
test('no values are synthesized from unlabeled or ambiguous multi-field fragments', () => {
  const idx = buildIndex([
    row('Application fee is Rs. 500', 1),
    row('Application fee: Rs. 500; Examination fee: Rs. 750', 2),
  ]);
  expect(directFieldAnswer(idx, answerQuestion(idx, 'Application fee', 'original'))).toBeNull();
});


test('generic application timing is not summarized as a closing date', () => {
  expect(directFieldAnswer(index, answerQuestion(index, 'When can I apply?', 'both'))).toBeNull();
  const opening = row('Application opening date: 1 December 2026', 3);
  const idx = buildIndex([original, opening]);
  const result = directFieldAnswer(idx, answerQuestion(idx, 'When will applications open?', 'original'));
  expect(result?.field.id).toBe('application_start');
  expect(result?.sides[0].values[0].value).toBe('1 December 2026');
});

test('review candidates include qualifying matches beyond the top four retrieval results', () => {
  const values = Array.from({ length: 8 }, (_, i) =>
    row('Application fee: Rs. ' + (500 + i), i + 1));
  const condition = row('Application fee may be waived for eligible applicants after verification.', 9);
  const idx = buildIndex([...values, condition]);
  const answer = answerQuestion(idx, 'Application fee', 'original');
  expect(answer.citations).not.toContain(condition);
  const side = directFieldAnswer(idx, answer)?.sides[0];
  expect(side?.otherMatchingPassages).toBe(1);
  expect(side?.reviewPassages).toEqual([{ source: condition, reason: 'query_match' }]);
});

test('nearby context requires geometry and immediate same-page same-role adjacency', () => {
  const positioned = (text: string, ordinal: number, y: number, x0 = 20,
    role: Passage['role'] = 'original', page = 1): Passage =>
    ({ ...row(text, ordinal, role, page), position: { x0, x1: x0 + 100, y, height: 10 } });
  const value = positioned('Application fee: Rs. 500', 3, 100);
  const preceding = positioned('Subject to the following conditions.', 2, 112);
  const following = positioned('Exemptions apply to eligible groups.', 4, 88);
  const otherColumn = positioned('Unrelated column content', 5, 76, 300);
  const anotherValue = positioned('Application fee: Rs. 600', 6, 64);
  const noGeometry = row('Text with unknown layout', 7);
  const otherRole = positioned('Other source context', 4, 88, 20, 'revised');
  const otherPage = positioned('Other page context', 4, 88, 20, 'original', 2);
  const idx = buildIndex([otherPage, following, value, preceding, otherColumn,
    anotherValue, noGeometry, otherRole]);
  const side = directFieldAnswer(idx, answerQuestion(idx, 'Application fee', 'original'))?.sides[0];
  expect(side?.nearbyPassages).toBe(2);
  expect(side?.reviewPassages).toEqual([
    { source: preceding, reason: 'nearby_line' },
    { source: following, reason: 'nearby_line' },
  ]);
});

test('query matches take precedence over nearby text and are deduplicated', () => {
  const value = { ...fee, ordinal: 1, position: { x0: 20, x1: 100, y: 100, height: 10 } };
  const condition = { ...row('Application fee is waived for eligible applicants.', 2),
    position: { x0: 20, x1: 120, y: 88, height: 10 } };
  const idx = buildIndex([value, condition, condition]);
  const side = directFieldAnswer(idx, answerQuestion(idx, 'Application fee', 'original'))?.sides[0];
  expect(side?.otherMatchingPassages).toBe(1);
  expect(side?.nearbyPassages).toBe(0);
  expect(side?.reviewPassages).toEqual([{ source: condition, reason: 'query_match' }]);
});

test('all review counts remain accurate with a bounded display and scoped physical page', () => {
  const matches = Array.from({ length: 10 }, (_, i) =>
    row('Application fee condition number ' + (i + 1), i + 2));
  const elsewhere = row('Application fee condition on another page', 1, 'original', 2);
  const otherRole = row('Application fee condition in another source', 1, 'revised');
  const idx = buildIndex([{ ...fee, ordinal: 1 }, ...matches.reverse(), elsewhere, otherRole]);
  const answer = answerScopedQuestions(idx, 'Application fee in original notice on page 1?',
    'auto', ['original', 'revised'])[0];
  const side = directFieldAnswer(idx, answer)?.sides[0];
  expect(side?.otherMatchingPassages).toBe(10);
  expect(side?.reviewPassages).toHaveLength(6);
  expect(side?.reviewPassages.map(p => p.source.ordinal)).toEqual([2, 3, 4, 5, 6, 7]);
});

test('a missing extraction ordinal prevents nearby context from bridging a gap', () => {
  const value = { ...fee, ordinal: 1, position: { x0: 20, x1: 100, y: 100, height: 10 } };
  const omittedGap = { ...row('Possible exception', 3),
    position: { x0: 20, x1: 100, y: 80, height: 10 } };
  const idx = buildIndex([value, omittedGap]);
  const side = directFieldAnswer(idx, answerQuestion(idx, 'Application fee', 'original'))?.sides[0];
  expect(side?.nearbyPassages).toBe(0);
  expect(side?.reviewPassages).toEqual([]);
});
