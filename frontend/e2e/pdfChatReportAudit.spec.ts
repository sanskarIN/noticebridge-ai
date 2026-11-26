import { expect, test } from '@playwright/test';
import { buildIndex, type Passage } from '../src/pdfChatCore';
import { summarize, type CaseMetrics, type RetrievalMode } from '../evaluation/retrievalMetrics';
import { auditReport, compareReports, MAX_EVALUATION_REPORT_BYTES } from '../evaluation/reportAudit';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const base: CaseMetrics[] = [
  { id: 'positive-a', family: 'family-a', slices: ['fee'], kind: 'answerable',
    retrieved: 1, relevant: 1, required: 1, requiredFound: 1, complete: true,
    abstained: false, reciprocalRank: 1, duplicateIds: 0, unknownIds: 0, roleLeaks: 0, pageLeaks: 0, routingMismatch: false },
  { id: 'positive-b', family: 'family-b', slices: ['date'], kind: 'answerable',
    retrieved: 0, relevant: 0, required: 2, requiredFound: 0, complete: false,
    abstained: true, reciprocalRank: 0, duplicateIds: 0, unknownIds: 0, roleLeaks: 0, pageLeaks: 0, routingMismatch: false },
  { id: 'negative-a', family: 'family-a', slices: ['negative'], kind: 'unanswerable',
    retrieved: 0, relevant: 0, required: 0, requiredFound: 0, complete: false,
    abstained: true, reciprocalRank: null, duplicateIds: 0, unknownIds: 0, roleLeaks: 0, pageLeaks: 0, routingMismatch: false },
];
const modes: RetrievalMode[] = ['strict', 'contextual', 'all-strict'];
function mode(mode: RetrievalMode, rows: CaseMetrics[]) {
  return { mode, totals: summarize(rows),
    slices: [...new Set(rows.flatMap(row => row.slices))].sort().map(slice =>
      ({ slice, ...summarize(rows.filter(row => row.slices.includes(slice))) })),
    families: [...new Set(rows.map(row => row.family))].sort().map(family =>
      ({ family, ...summarize(rows.filter(row => row.family === family)) })), cases: rows };
}
function report(rows: CaseMetrics[]) {
  return { format: 'noticebridge-retrieval-evaluation', version: 1,
    dataset: 'study', label_kind: 'synthetic', split: 'holdout', documents: ['doc-a', 'doc-b'],
    synthetic: true, authority_verified: false,
    integrity_violations: rows.reduce((sum, row) => sum + row.duplicateIds + row.unknownIds +
      row.roleLeaks + row.pageLeaks + Number(row.routingMismatch), 0) * 3,
    modes: modes.map(value => mode(value, structuredClone(rows))),
    transitions: modes.slice(1).map(value => ({ mode: value, gained: [], lost: [], abstentionRegressions: [] })),
    manifest_sha256: 'a'.repeat(64) };
}
const next = [
  { ...base[0], retrieved: 0, relevant: 0, requiredFound: 0, complete: false, abstained: true, reciprocalRank: 0 },
  { ...base[1], retrieved: 2, relevant: 2, requiredFound: 2, complete: true, abstained: false, reciprocalRank: 1 },
  { ...base[2], retrieved: 1, abstained: false },
];
const beforeText = JSON.stringify(report(base)), afterText = JSON.stringify(report(next));
test('audit recomputes every report aggregate and paired comparison counts gains and losses separately', () => {
  const old = auditReport(beforeText), current = auditReport(afterText);
  const compared = compareReports(old, current);
  expect(compared.modes[0].positiveEvidence).toEqual({ gained: 1, lost: 1, both: 0, neither: 0, cases: 2 });
  expect(compared.modes[0].negativeAbstention).toEqual({ gained: 0, lost: 1, both: 0, neither: 0, cases: 1 });
  expect(compared.modes[0].rates.find(item => item.metric === 'completeEvidenceRate')?.delta).toBe(0);
  expect(compared.modes[0].rates.find(item => item.metric === 'unanswerableAbstentionRate')?.delta).toBe(-1);
  expect(compared.modes[0].familyResults).toHaveLength(2);
  expect(compared.modes[0].changed.map(row => row.id)).toEqual(base.map(row => row.id));
  expect(compared.authority_verified).toBe(false);
  expect(compared.integrity_regression).toBe(false);
});
test('undefined denominators stay null rather than being treated as perfect performance', () => {
  const old = auditReport(JSON.stringify(report(base.slice(0, 2))));
  const compared = compareReports(old, old);
  expect(compared.modes[0].negativeAbstention.cases).toBe(0);
  expect(compared.modes[0].rates.find(item => item.metric === 'unanswerableAbstentionRate'))
    .toEqual({ metric: 'unanswerableAbstentionRate', before: null, after: null, delta: null });
});
test('integrity regression is reported separately from retrieval quality', () => {
  const rows = structuredClone(base);
  rows[0].routingMismatch = true;
  const comparison = compareReports(auditReport(beforeText), auditReport(JSON.stringify(report(rows))));
  expect(comparison.integrity_regression).toBe(true);
  expect(comparison.modes[0].integrity).toEqual({ before: 0, after: 1 });
});
for (const [name, mutate] of [
  ['aggregate', (value: any) => value.modes[0].totals.complete = 20],
  ['slice rate', (value: any) => value.modes[0].slices[0].citationRecall = 1],
  ['family count', (value: any) => value.modes[0].families[0].cases = 7],
  ['transition', (value: any) => value.transitions[0].gained = ['positive-b']],
  ['integrity', (value: any) => value.integrity_violations = 1],
  ['mode order', (value: any) => value.modes.reverse()],
  ['duplicate case', (value: any) => value.modes[0].cases.push(value.modes[0].cases[0])],
  ['negative reciprocal rank', (value: any) => value.modes[0].cases[2].reciprocalRank = 1],
  ['impossible count', (value: any) => value.modes[0].cases[0].requiredFound = 2],
  ['claimed authority', (value: any) => value.authority_verified = true],
  ['extra question text', (value: any) => value.modes[0].cases[0].question = 'private'],
  ['forged case identity', (value: any) => value.modes[1].cases[0].family = 'other'],
] as const) {
  test('report audit rejects inconsistent ' + name, () => {
    const value = report(base); mutate(value);
    expect(() => auditReport(JSON.stringify(value))).toThrow();
  });
}
test('paired report comparison requires matching pinned dataset, split, labels and case identities', () => {
  const old = auditReport(beforeText);
  for (const change of [
    { manifest_sha256: 'b'.repeat(64) }, { split: 'development' }, { dataset: 'different' },
    { documents: ['doc-a'] }, { label_kind: 'independently_reviewed', synthetic: false },
  ]) {
    const candidate = auditReport(JSON.stringify({ ...report(next), ...change }));
    expect(() => compareReports(old, candidate)).toThrow();
  }
  const changed = next.map(row => ({ ...row, family: 'new-family' }));
  expect(() => compareReports(old, auditReport(JSON.stringify(report(changed))))).toThrow();
});
test('impossible per-case counts are rejected even when aggregates were recomputed', () => {
  for (const changes of [{ relevant: 2 }, { reciprocalRank: 0.3 }, { unknownIds: 2 }, { complete: false }]) {
    const rows = [{ ...base[0], ...changes }, ...base.slice(1)];
    expect(() => auditReport(JSON.stringify(report(rows)))).toThrow();
  }
});
test('oversized and invalid report formats are rejected', () => {
  expect(() => auditReport('x'.repeat(MAX_EVALUATION_REPORT_BYTES + 1))).toThrow();
  expect(() => auditReport('{}')).toThrow();
  expect(() => auditReport('not JSON')).toThrow();
});
test('report comparison CLI publishes an exclusive bound output and rejects mismatched files', ({}, info) => {
  test.setTimeout(120_000);
  const root = info.outputPath('report-audit'), bundle = join(root, 'bundle');
  mkdirSync(root, { recursive: true });
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build',
    '--ssr', 'evaluation/compare.ts', '--outDir', bundle], { timeout: 60_000, stdio: 'pipe' });
  writeFileSync(join(bundle, 'package.json'), '{"type":"module"}\n');
  const before = join(root, 'before.json'), after = join(root, 'after.json'), output = join(root, 'comparison.json');
  writeFileSync(before, beforeText); writeFileSync(after, afterText);
  const run = (destination: string) => spawnSync(process.execPath, [
    join(bundle, 'compare.js'), '--before', before, '--after', after, '--output', destination,
  ], { encoding: 'utf8', timeout: 15_000 });
  const result = run(output);
  expect(result.status, result.stderr).toBe(0);
  const text = readFileSync(output, 'utf8'), value = JSON.parse(text);
  expect(value.before_sha256).toBe(createHash('sha256').update(beforeText).digest('hex'));
  expect(value.after_sha256).toBe(createHash('sha256').update(afterText).digest('hex'));
  expect(value.modes[0].positiveEvidence.gained).toBe(1);
  expect(run(output).status).toBe(1);
  expect(readFileSync(output, 'utf8')).toBe(text);
  writeFileSync(after, JSON.stringify({ ...report(next), manifest_sha256: 'c'.repeat(64) }));
  expect(run(join(root, 'rejected.json')).status).toBe(1);
  expect(existsSync(join(root, 'rejected.json'))).toBe(false);
});
