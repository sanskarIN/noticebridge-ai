import { expect, test } from '@playwright/test';
import { buildIndex, type Passage } from '../src/pdfChatCore';
import { identity, runRetrievalEvaluation, scoreCase, summarize, validateCases,
  type RetrievalCase } from '../evaluation/retrievalMetrics';

function row(text: string, page: number, ordinal = 1, role: Passage['role'] = 'original'): Passage {
  return { text, page, ordinal, role };
}
const lines = [
  row('Application fee: Rs. 500', 1),
  row('Application fee: Rs. 600', 2),
  row('Application fee: Rs. 700', 3),
  row('Application fee: Rs. 800', 4),
  row('Application fee: Rs. 900', 5),
  row('Rural applicants', 6),
  row('Residence certificate required', 6, 2),
  row('Eligibility: Class 12', 7),
  row('Eligibility criteria: Class 12', 8),
  row('Application fee: Rs. 350', 1, 1, 'revised'),
];
const index = buildIndex(lines);
const available = new Set(lines.map(identity));
const cases: RetrievalCase[] = [
  { id: 'competing-values', family: 'fictional-a', slices: ['conflicts', 'multi-page'],
    question: 'Application fee?', scope: 'original',
    label: { kind: 'answerable', evidenceSets: [lines.slice(0, 5).map(identity)] } },
  { id: 'adjacent-lines', family: 'fictional-a', slices: ['context'],
    question: 'Rural residence certificate?', scope: 'original',
    label: { kind: 'answerable', evidenceSets: [lines.slice(5, 7).map(identity)] } },
  { id: 'alternative-evidence', family: 'fictional-a', slices: ['aliases'],
    question: 'Eligibility?', scope: 'original',
    label: { kind: 'answerable', evidenceSets: [[identity(lines[7])], [identity(lines[8])]] } },
  { id: 'scoped-revision', family: 'fictional-b', slices: ['scope'],
    question: 'Application fee on page 1?', scope: 'revised', page: 1,
    label: { kind: 'answerable', evidenceSets: [[identity(lines[9])]] } },
  { id: 'absent-refund', family: 'fictional-b', slices: ['negative'],
    question: 'Application fee refund?', scope: 'both', label: { kind: 'unanswerable' } },
  { id: 'unindexed-page', family: 'fictional-b', slices: ['coverage'],
    question: 'Fee on page 80?', scope: 'original', page: 80, label: { kind: 'unindexed' } },
  { id: 'ambiguous-subject', family: 'fictional-a', slices: ['ambiguity'],
    question: 'What about it?', scope: 'both', label: { kind: 'ambiguous' } },
];
test('evaluation distinguishes contextual and full-ranking recall improvements', () => {
  const strict = runRetrievalEvaluation(index, cases, 'strict', ['original', 'revised']);
  const contextual = runRetrievalEvaluation(index, cases, 'contextual', ['original', 'revised']);
  const all = runRetrievalEvaluation(index, cases, 'all-strict', ['original', 'revised']);
  expect(strict.totals.complete).toBe(2);
  expect(contextual.totals.complete).toBe(3);
  expect(all.totals.complete).toBe(3);
  expect(contextual.cases.find(row => row.id === 'adjacent-lines')?.complete).toBe(true);
  expect(all.cases.find(row => row.id === 'competing-values')?.complete).toBe(true);
  for (const report of [strict, contextual, all]) {
    expect(report.totals.roleLeaks).toBe(0);
    expect(report.totals.pageLeaks).toBe(0);
    expect(report.totals.unknownIds).toBe(0);
    expect(report.totals.routingMismatches).toBe(0);
    expect(report.totals.unanswerableAbstentionRate).toBe(1);
    expect(report.totals.inaccessibleAbstentionRate).toBe(1);
    expect(report.totals.ambiguousAbstentionRate).toBe(1);
    expect(report.totals.citationPrecision).toBe(1);
    expect(report.totals.families).toBe(2);
    expect(JSON.stringify(report)).not.toContain('Application fee');
  }
  console.log(JSON.stringify({ synthetic: true, strict: strict.totals,
    contextual: contextual.totals, allStrict: all.totals }));
});

test('alternative sufficient evidence sets do not require their union', () => {
  const item = cases[2];
  const output = scoreCase(item, { ids: [identity(lines[8])], actualScope: 'original' }, available);
  expect(output.required).toBe(1);
  expect(output.requiredFound).toBe(1);
  expect(output.complete).toBe(true);
  expect(output.reciprocalRank).toBe(1);
});
test('partial evidence from different alternative sets does not constitute completeness', () => {
  const item: RetrievalCase = { ...cases[0], label: { kind: 'answerable', evidenceSets: [
    [identity(lines[0]), identity(lines[1])], [identity(lines[2]), identity(lines[3])],
  ] } };
  const result = scoreCase(item, { ids: [identity(lines[0]), identity(lines[2])],
    actualScope: 'original' }, available);
  expect(result.relevant).toBe(2);
  expect(result.requiredFound).toBe(1);
  expect(result.required).toBe(2);
  expect(result.complete).toBe(false);
});
test('scope leakage, invalid IDs, duplicates and route mismatch are counted separately', () => {
  const item = cases[3];
  const result = scoreCase(item, { actualScope: 'both', actualPage: 2, ids: [
    identity(lines[0]), identity(lines[1]), 'revised:8:1', identity(lines[9]), identity(lines[9]),
  ] }, available);
  expect(result.roleLeaks).toBe(2);
  expect(result.pageLeaks).toBe(1);
  expect(result.unknownIds).toBe(1);
  expect(result.duplicateIds).toBe(1);
  expect(result.routingMismatch).toBe(true);
  expect(result.relevant).toBe(1);
  expect(result.reciprocalRank).toBe(0.25);
});
test('unindexed and ambiguous cases do not inflate judged negative abstention', () => {
  const result = summarize([
    scoreCase(cases[4], { ids: [identity(lines[0])], actualScope: 'both' }, available),
    scoreCase(cases[5], { ids: [], actualScope: 'original', actualPage: 80 }, available),
    scoreCase(cases[6], { ids: [], actualScope: 'both' }, available),
  ]);
  expect(result.unanswerableAbstentionRate).toBe(0);
  expect(result.inaccessibleAbstentionRate).toBe(1);
  expect(result.ambiguousAbstentionRate).toBe(1);
  expect(result.completeEvidenceRate).toBeNull();
  expect(result.citationRecall).toBeNull();
  expect(result.citationPrecision).toBe(0);
});
test('empty slices report null ratios instead of false perfect accuracy', () => {
  const result = summarize([]);
  expect(result.citationPrecision).toBeNull();
  expect(result.citationRecall).toBeNull();
  expect(result.meanReciprocalRank).toBeNull();
  expect(result.unanswerableAbstentionRate).toBeNull();
});
test('evidence labels must exist and match the annotated source and physical page', () => {
  for (const ids of [['original:80:1'], [identity(lines[0])], [identity(lines[9]), identity(lines[9])]]) {
    const item: RetrievalCase = { ...cases[3], label: { kind: 'answerable', evidenceSets: [ids] } };
    expect(() => validateCases(index, [item])).toThrow();
  }
});
test('dataset validation rejects repeated cases, repeated alternatives and duplicate source identities', () => {
  expect(() => validateCases(index, [cases[0], cases[0]])).toThrow();
  expect(() => validateCases(index, [{ ...cases[0], label: { kind: 'answerable',
    evidenceSets: [[identity(lines[0])], [identity(lines[0])]] } }])).toThrow();
  expect(() => validateCases(buildIndex([...lines, lines[0]]), cases)).toThrow();
});
test('slices overlap but overall denominators count each case once', () => {
  const report = runRetrievalEvaluation(index, cases, 'strict', ['original', 'revised']);
  expect(report.slices.reduce((n, slice) => n + slice.cases, 0)).toBe(cases.length + 1);
  expect(report.totals.cases).toBe(cases.length);
  expect(report.families.reduce((n, family) => n + family.cases, 0)).toBe(cases.length);
});
