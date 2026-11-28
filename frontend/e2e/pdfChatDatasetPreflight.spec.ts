import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compareNativeSketches, normalizedTokens, sketchNativeText, SKETCH_SIZE, MAX_SOURCE_TOKENS } from '../evaluation/nativeTextSketch';
import { preflightDataset, replayPreflight, MAX_PREFLIGHT_BYTES, type PreflightInput } from '../evaluation/datasetPreflight';
import { preparePreflightReview, auditPreflightReview, replayPreflightReview, MAX_REVIEW_NOTE_LENGTH } from '../evaluation/preflightReview';
import { serializeCorpusSnapshot } from '../src/pdfChatCorpusSnapshot';
import type { Corpus, Passage } from '../src/pdfChatCore';
import type { ChatCorpora } from '../src/pdfChatEvidenceReport';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
function passage(text: string, ordinal = 1, role: Passage['role'] = 'original', page = 1): Passage {
  return { role, page, ordinal, text };
}
function corpus(passages: Passage[], patch: Partial<Corpus> = {}): Corpus {
  return { passages, pageCount: 1, processedPages: 1, missingPages: [], limitedPages: [], limited: false, ...patch };
}
function numberedWords(start: number, count: number) {
  return Array.from({ length: count }, (_, i) => 'word' + (start + i)).join(' ');
}
function chunked(start: number, count: number): Passage[] {
  const rows: Passage[] = [];
  for (let at = 0; at < count; at += 40) rows.push(passage(numberedWords(start + at, Math.min(40, count - at)), rows.length + 1));
  return rows;
}
test('normalized sequence ignores case, punctuation and extraction line wrapping, preserves numeric tokens and order', () => {
  expect([...normalizedTokens('ＦＥＥ: INR 500,  café')]).toEqual(['fee', 'inr', '500', 'café']);
  const a = sketchNativeText([passage('Application Fee: INR 500 due Monday.'), passage('Bring a certificate.', 2)]);
  const b = sketchNativeText([passage('application fee INR 500 DUE'), passage('Monday bring a certificate', 2)]);
  expect(a).toEqual(b);
  expect(sketchNativeText([passage('application fee INR 350 due Monday bring a certificate')]).normalizedSha256)
    .not.toBe(a.normalizedSha256);
  expect(sketchNativeText([passage('INR application fee 500 due Monday bring a certificate')]).normalizedSha256)
    .not.toBe(a.normalizedSha256);
});
test('small complete shingle sets have exact sampled union and intersection counts', () => {
  const a = sketchNativeText([passage('a b c d e f g')]);
  const b = sketchNativeText([passage('b c d e f g h')]);
  expect(a.hashes).toHaveLength(3);
  expect(compareNativeSketches(a, b)).toEqual({ unionSample: 4, sharedSample: 2, jaccard: 0.5, sampled: false });
  expect(compareNativeSketches(a, a)).toEqual({ unionSample: 3, sharedSample: 3, jaccard: 1, sampled: false });
  const repeated = sketchNativeText([passage('a a a a a a a a')]);
  expect(repeated.hashes).toHaveLength(1);
  expect(compareNativeSketches(a, repeated).sharedSample).toBe(0);
  const short = sketchNativeText([passage('a b')]);
  expect(compareNativeSketches(short, short)).toEqual({ unionSample: 0, sharedSample: 0, jaccard: null, sampled: false });
});
test('bottom-k sketch is deterministic, bounded and distinguishes overlapping and disjoint sequences', () => {
  const a = sketchNativeText(chunked(0, 2500)), b = sketchNativeText(chunked(500, 2500)), c = sketchNativeText(chunked(6000, 2500));
  expect(a.hashes).toHaveLength(SKETCH_SIZE);
  expect(a.truncated).toBe(true);
  expect(a.hashes.every((value, i) => Number.isSafeInteger(value) && (i === 0 || value > a.hashes[i - 1]))).toBe(true);
  expect(sketchNativeText(chunked(0, 2500))).toEqual(a);
  const overlap = compareNativeSketches(a, b), reverse = compareNativeSketches(b, a);
  expect(overlap).toEqual(reverse);
  expect(overlap.unionSample).toBe(SKETCH_SIZE);
  expect(overlap.sampled).toBe(true);
  // True shingle-set Jaccard is about 2/3. The fixed bounded sketch
  // is an approximation, not a requirement of exact equality.
  expect(overlap.jaccard).toBeGreaterThan(0.5);
  expect(overlap.jaccard).toBeLessThan(0.8);
  expect(compareNativeSketches(a, c).jaccard).toBeLessThan(0.02);
  expect(compareNativeSketches(a, a)).toMatchObject({ jaccard: 1, sampled: true });
});
test('invalid sketch sizes, token budgets and unordered hashes fail closed', () => {
  const sketch = sketchNativeText([passage('a b c d e f g')]);
  expect(() => sketchNativeText([passage('a b c')], 2)).toThrow();
  expect(() => sketchNativeText([], MAX_SOURCE_TOKENS + 1)).toThrow();
  expect(() => sketchNativeText([], -1)).toThrow();
  expect(() => compareNativeSketches(sketch, { ...sketch, hashes: [10, 1] })).toThrow();
  expect(() => compareNativeSketches(sketch, { ...sketch, hashes: [1, 1] })).toThrow();
  expect(() => compareNativeSketches(sketch, { ...sketch, hashes: [NaN] })).toThrow();
  expect(() => compareNativeSketches(sketch, { ...sketch, truncated: true })).toThrow();
});
const longText = 'Application fee INR 500. ' + numberedWords(0, 35);
function doc(id: string, family: string, split: 'development' | 'holdout', corpora: ChatCorpora, cases: unknown[]) {
  const pins = Object.fromEntries(Object.keys(corpora).map(role => [role, sha(id + ':' + role)]));
  const text = serializeCorpusSnapshot(pins, corpora);
  return { label: { id, family, split, snapshot: id + '.json', snapshot_sha256: sha(text), cases },
    artifact: { name: id + '.json', text, sha256: sha(text) } };
}
function row(id: string, question = 'Application fee?', kind = 'answerable', scope = 'original', page?: number) {
  return { id, slices: ['private-slice'], question, scope, ...(page === undefined ? {} : { page }),
    label: kind === 'answerable' ? { kind, evidenceSets: [[scope === 'revised' ? 'revised:1:1' : 'original:1:1']] } : { kind } };
}
function fixture() {
  const a = doc('dev-a', 'family-a', 'development', {
    original: corpus([passage(longText)]), revised: corpus([passage(numberedWords(200, 35), 1, 'revised')]),
  }, [
    row('fee-a'), row('fee-a-repeat', 'APPLICATION FEE!', 'unanswerable'),
    row('scope-conflict', 'Application fee in revised notice?', 'answerable'),
    row('both-scope', 'Application fee?', 'answerable', 'both'),
    row('no-native', 'Refund policy on page 2?', 'unanswerable', 'original', 2),
    row('unindexed-some', 'Scholarship policy?', 'unindexed'),
    row('empty-terms', 'What?', 'unanswerable'),
  ]);
  const sameFamily = doc('dev-same-family', 'family-a', 'development',
    { original: corpus([passage(longText)]) }, [row('fee-family')]);
  const b = doc('hold-b', 'family-b', 'holdout', { original: corpus([passage(longText.toUpperCase().replace(/[.]/g, ''))]) },
    [row('fee-b')]);
  const near = doc('hold-c', 'family-c', 'holdout', {
    original: corpus([passage(longText.replace('500', '350'))]),
  }, [row('fee-c')]);
  const short = doc('hold-short', 'family-short', 'holdout', { original: corpus([passage('Fee INR 500')]) },
    [row('fee-short')]);
  const limited = doc('hold-limited', 'family-limited', 'holdout', {
    original: corpus([], { pageCount: 2, processedPages: 1, missingPages: [1], limitedPages: [1], limited: true }),
  }, [row('negative-limited', 'Refund policy on page 1?', 'unanswerable', 'original', 1)]);
  const docs = [a, sameFamily, b, near, short, limited];
  return { manifest: encode({ format: 'noticebridge-retrieval-labels', version: 1,
    id: 'private-study', kind: 'synthetic', documents: docs.map(item => item.label) }),
    artifacts: docs.map(item => item.artifact) } satisfies PreflightInput;
}
const settings = { similarityThreshold: 0.7 };
test('dataset preflight catches distinct-PDF identical sequences and high overlap across families and splits', () => {
  const input = fixture(), result = preflightDataset(input, settings);
  expect(result.report.manifest_sha256).toBe(sha(input.manifest));
  expect(result.report.summary).toMatchObject({ documents: 6, families: 5, source_roles: 7,
    short_or_empty_sources: 2, same_family_pairs_skipped: 3 });
  const exact = result.report.pair_leads.find(row => row.left.document === 'dev-a' &&
    row.left.role === 'original' && row.right.document === 'hold-b');
  expect(exact).toMatchObject({ kind: 'exact_normalized_sequence', cross_split: true, jaccard_estimate: 1 });
  const near = result.report.pair_leads.find(row => row.left.document === 'dev-a' &&
    row.left.role === 'original' && row.right.document === 'hold-c');
  expect(near?.kind).toBe('high_shingle_overlap');
  expect(near?.cross_split).toBe(true);
  expect(result.report.pair_leads.every(row => row.left.family !== row.right.family)).toBe(true);
  expect(result.report.pair_leads.every(row => !['hold-short', 'hold-limited'].includes(row.left.document) &&
    !['hold-short', 'hold-limited'].includes(row.right.document))).toBe(true);
  expect(result.report.summary.cross_split_leads).toBeGreaterThan(0);
  expect(result.report.authority_verified).toBe(false);
  expect(result.report.label_correctness_verified).toBe(false);
  expect(result.report.release_approved).toBe(false);
});
test('question repetition is a separate diagnostic, and contradictory local labels require review', () => {
  const result = preflightDataset(fixture(), settings).report;
  expect(result.question_overlap).toMatchObject({ repeated_routes_within_document: 1,
    differing_labels_within_document: 1, cross_split_routes: 1 });
  expect(result.question_overlap.development_cases_in_shared_routes).toBe(3);
  expect(result.question_overlap.holdout_cases_in_shared_routes).toBe(3);
  const leads = new Map(result.case_leads.map(row => [row.id, row]));
  for (const id of ['fee-a', 'fee-a-repeat']) {
    expect(leads.get(id)?.flags).toContain('repeated_question_in_document');
    expect(leads.get(id)?.flags).toContain('repeated_question_different_labels');
  }
  expect(leads.has('fee-b')).toBe(false);
  expect(leads.get('scope-conflict')?.flags).toContain('explicit_scope_conflict');
  expect(leads.get('both-scope')?.flags).toContain('both_scope_alternative_one_role');
  expect(leads.get('no-native')?.flags).toEqual(['requested_text_unavailable', 'negative_with_limited_coverage']);
  expect(leads.get('unindexed-some')?.flags).toContain('unindexed_with_some_text');
  expect(leads.get('empty-terms')?.flags).toContain('empty_search_terms');
  expect(leads.get('negative-limited')?.flags).toContain('requested_text_unavailable');
  expect(leads.get('negative-limited')?.coverage).toEqual([{ role: 'original', state: 'limited' }]);
});
test('raising overlap threshold removes near leads but not exact normalized sequence leads', () => {
  const low = preflightDataset(fixture(), settings).report;
  const high = preflightDataset(fixture(), { similarityThreshold: 1 }).report;
  expect(high.pair_leads.length).toBeLessThan(low.pair_leads.length);
  expect(high.summary.exact_sequence_leads).toBe(low.summary.exact_sequence_leads);
  expect(high.pair_leads.every(row => row.kind === 'exact_normalized_sequence')).toBe(true);
});
test('preflight replay binds exact input bytes, settings and candidate details, without exposing question wording', () => {
  const input = fixture(), result = preflightDataset(input, settings);
  for (const secret of [longText, 'Application fee?', 'Refund policy', 'private-slice', 'Scholarship policy?', 'word0']) {
    expect(result.text).not.toContain(secret);
  }
  expect(replayPreflight(result.text, input, settings)).toEqual(result.report);
  expect(preflightDataset({ ...input, artifacts: [...input.artifacts].reverse() }, settings).text).toBe(result.text);
  expect(() => replayPreflight(result.text.trim(), input, settings)).toThrow();
  expect(() => replayPreflight(result.text, { ...input, manifest: input.manifest + ' ' }, settings)).toThrow();
  expect(() => replayPreflight(result.text, input, { similarityThreshold: 0.9 })).toThrow();
  expect(() => replayPreflight(result.text.replace('"release_approved": false', '"release_approved": true'), input, settings)).toThrow();
  expect(() => replayPreflight('x'.repeat(MAX_PREFLIGHT_BYTES + 1), input, settings)).toThrow();
});
test('preflight rejects invalid source bindings and settings rather than producing a partial result', () => {
  const input = fixture();
  for (const invalid of [NaN, Infinity, 0.49, 1.1]) {
    expect(() => preflightDataset(input, { similarityThreshold: invalid })).toThrow();
  }
  expect(() => preflightDataset(input, { similarityThreshold: 0.7, extra: true } as any)).toThrow();
  expect(() => preflightDataset({ ...input, artifacts: input.artifacts.slice(1) }, settings)).toThrow();
  const tampered = structuredClone(input);
  tampered.artifacts[0].text += ' ';
  expect(() => preflightDataset(tampered, settings)).toThrow();
});
test('CLI writes exclusive private preflight and verifies exact replay without exposing case details', ({}, info) => {
  test.setTimeout(120_000);
  const root = info.outputPath('preflight-cli'), bundle = join(root, 'bundle');
  mkdirSync(root, { recursive: true });
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--ssr',
    'evaluation/preflight.ts', '--outDir', bundle], { timeout: 60_000, stdio: 'pipe' });
  writeFileSync(join(bundle, 'package.json'), '{"type":"module"}\n');
  const input = fixture(), manifest = join(root, 'manifest.json'), output = join(root, 'preflight.json');
  writeFileSync(manifest, input.manifest);
  for (const artifact of input.artifacts) writeFileSync(join(root, artifact.name), artifact.text);
  const args = ['--manifest', manifest, '--threshold', '0.7', '--output', output];
  const run = (values: string[]) => spawnSync(process.execPath, [join(bundle, 'preflight.js'), ...values],
    { timeout: 30_000, encoding: 'utf8' });
  expect(run(['--help']).status).toBe(0);
  const produced = run(args);
  expect(produced.status, produced.stderr).toBe(0);
  const expected = preflightDataset(input, settings);
  expect(readFileSync(output, 'utf8')).toBe(expected.text);
  expect(JSON.parse(produced.stdout)).toMatchObject({ consistent: true, verified_replay: false,
    release_approved: false, summary: expected.report.summary });
  for (const secret of [root, 'Application fee', 'fee-a-repeat', 'family-a', 'word0']) {
    expect(produced.stdout + produced.stderr).not.toContain(secret);
  }
  const verified = run([...args, '--verify']);
  expect(verified.status, verified.stderr).toBe(0);
  expect(JSON.parse(verified.stdout).verified_replay).toBe(true);
  expect(run(args).status).toBe(1);
  expect(readFileSync(output, 'utf8')).toBe(expected.text);
  expect(run([...args, '--threshold', '0.8']).status).toBe(1);
  expect(run([...args, '--verify', '--verify']).status).toBe(1);
  const missing = join(root, 'invalid.json'), invalid = [...args];
  invalid[invalid.indexOf('--output') + 1] = missing;
  invalid[invalid.indexOf('--threshold') + 1] = '0.4';
  expect(run(invalid).status).toBe(1);
  expect(existsSync(missing)).toBe(false);
  writeFileSync(join(root, input.artifacts[0].name), input.artifacts[0].text + ' ');
  expect(run([...args, '--verify']).status).toBe(1);
  expect(readFileSync(output, 'utf8')).toBe(expected.text);
});


function reviewFixture() {
  const input = fixture(), preflight = preflightDataset(input, settings);
  const prepared = preparePreflightReview(preflight.text, input, settings);
  return { input, preflight, prepared };
}
function disposition(queue: ReturnType<typeof preparePreflightReview>['queue']) {
  const next = structuredClone(queue);
  for (const pair of next.pairs) {
    pair.decision = 'distinct_after_inspection';
    pair.note = 'Private pair rationale.';
  }
  for (const row of next.cases) {
    row.decision = 'retained_after_inspection';
    row.note = 'Private case rationale.';
  }
  return next;
}
test('preflight review starts with every candidate pending and no generated rationale', () => {
  const { input, preflight, prepared } = reviewFixture();
  expect(prepared.queue.pairs.map(row => row.id)).toEqual(preflight.report.pair_leads.map(row => row.id));
  expect(prepared.queue.cases.map(row => row.id)).toEqual(preflight.report.case_leads.map(row => row.id));
  expect([...prepared.queue.pairs, ...prepared.queue.cases].every(row => row.decision === 'pending' && row.note === '')).toBe(true);
  const result = auditPreflightReview(prepared.text, preflight.text, input, settings);
  expect(result.audit.summary.pair_decisions.pending).toBe(prepared.queue.pairs.length);
  expect(result.audit.summary.case_decisions.pending).toBe(prepared.queue.cases.length);
  expect(result.audit.summary.cross_split_pairs_pending_or_uncertain).toBe(preflight.report.summary.cross_split_leads);
  expect(result.audit.all_leads_disposed_without_changes).toBe(false);
});
test('human dispositions are replayable, private and never attest correctness or independence', () => {
  const { input, preflight, prepared } = reviewFixture();
  const edited = disposition(prepared.queue);
  edited.pairs.reverse();
  edited.cases.reverse();
  const queue = encode(edited);
  const result = auditPreflightReview(queue, preflight.text, input, settings);
  expect(result.audit.all_leads_disposed_without_changes).toBe(true);
  expect(result.audit).toMatchObject({
    queue_sha256: sha(queue), preflight_sha256: sha(preflight.text), manifest_sha256: sha(input.manifest),
    authority_verified: false, reviewer_verified: false, independence_verified: false,
    label_correctness_verified: false, release_approved: false,
  });
  expect(result.audit.summary.unresolved_pairs).toEqual([]);
  expect(result.audit.summary.unresolved_cases).toEqual([]);
  expect(result.text).not.toContain('Private pair rationale');
  expect(result.text).not.toContain('Private case rationale');
  expect(replayPreflightReview(result.text, queue, preflight.text, input, settings)).toEqual(result.audit);
  expect(() => replayPreflightReview(result.text, queue + ' ', preflight.text, input, settings)).toThrow();
  expect(() => replayPreflightReview(result.text + ' ', queue, preflight.text, input, settings)).toThrow();
});
test('regroup, revision and uncertain decisions remain outstanding', () => {
  const { input, preflight, prepared } = reviewFixture();
  const edited = disposition(prepared.queue);
  const cross = preflight.report.pair_leads.find(row => row.cross_split)!;
  const pair = edited.pairs.find(row => row.id === cross.id)!;
  pair.decision = 'regroup_required';
  edited.cases[0].decision = 'revision_required';
  edited.cases[1].decision = 'uncertain';
  const result = auditPreflightReview(encode(edited), preflight.text, input, settings).audit;
  expect(result.all_leads_disposed_without_changes).toBe(false);
  expect(result.summary.cross_split_pairs_requiring_regroup).toBe(1);
  expect(result.summary.pairs_requiring_regroup).toEqual([pair.id]);
  expect(result.summary.cases_requiring_revision).toEqual([edited.cases[0].id]);
  expect(result.summary.unresolved_cases).toEqual([edited.cases[1].id]);
});
test('missing, duplicate, mismatched and forged review entries fail closed', () => {
  const { input, preflight, prepared } = reviewFixture();
  const check = (queue: unknown) => auditPreflightReview(encode(queue), preflight.text, input, settings);
  const edits = [
    (q: any) => q.pairs.pop(),
    (q: any) => q.cases.push(q.cases[0]),
    (q: any) => q.pairs[0].id = 'unknown',
    (q: any) => q.cases[0].id = q.cases[1].id,
    (q: any) => q.pairs[0].decision = 'retained_after_inspection',
    (q: any) => q.cases[0].decision = 'distinct_after_inspection',
    (q: any) => q.cases[0].decision = 'retained_after_inspection',
    (q: any) => q.cases[0].note = 'unexpected pending note',
    (q: any) => Object.assign(q.cases[0], { decision: 'uncertain', note: '   ' }),
    (q: any) => Object.assign(q.cases[0], { decision: 'uncertain', note: 'a'.repeat(MAX_REVIEW_NOTE_LENGTH + 1) }),
    (q: any) => Object.assign(q.cases[0], { decision: 'uncertain', note: 'a\nb' }),
    (q: any) => q.manifest_sha256 = '0'.repeat(64),
    (q: any) => q.preflight_sha256 = '0'.repeat(64),
    (q: any) => q.similarity_threshold = 0.9,
    (q: any) => q.release_approved = true,
    (q: any) => q.pairs[0].extra = true,
  ];
  for (const mutate of edits) {
    const edited = structuredClone(prepared.queue);
    mutate(edited);
    expect(() => check(edited)).toThrow();
  }
  expect(() => auditPreflightReview(prepared.text.replace('"version": 1', '"version": 1, "version": 1'),
    preflight.text, input, settings)).toThrow();
  expect(() => preparePreflightReview(preflight.text + ' ', input, settings)).toThrow();
  expect(() => auditPreflightReview(prepared.text, preflight.text, input, { similarityThreshold: 0.9 })).toThrow();
});
test('zero-lead queues are valid but are not proof of an independently verified dataset', () => {
  const source = doc('only-doc', 'only-family', 'development',
    { original: corpus([passage(longText)]) }, [row('one-case')]);
  const input = { manifest: encode({ format: 'noticebridge-retrieval-labels', version: 1,
    id: 'one-study', kind: 'synthetic', documents: [source.label] }), artifacts: [source.artifact] };
  const report = preflightDataset(input, settings);
  const prepared = preparePreflightReview(report.text, input, settings);
  expect(prepared.queue.pairs).toEqual([]);
  expect(prepared.queue.cases).toEqual([]);
  expect(auditPreflightReview(prepared.text, report.text, input, settings).audit).toMatchObject({
    all_leads_disposed_without_changes: true, independence_verified: false, release_approved: false,
  });
});
test('review CLI prepares, audits and verifies without printing private notes', ({}, info) => {
  test.setTimeout(120_000);
  const root = info.outputPath('review-preflight-cli'), bundle = join(root, 'bundle');
  mkdirSync(root, { recursive: true });
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--ssr',
    'evaluation/reviewPreflight.ts', '--outDir', bundle], { timeout: 60_000, stdio: 'pipe' });
  writeFileSync(join(bundle, 'package.json'), '{"type":"module"}\n');
  const { input, preflight, prepared } = reviewFixture();
  const manifest = join(root, 'manifest.json'), report = join(root, 'preflight.json');
  const queue = join(root, 'queue.json'), audit = join(root, 'audit.json');
  writeFileSync(manifest, input.manifest);
  writeFileSync(report, preflight.text);
  for (const artifact of input.artifacts) writeFileSync(join(root, artifact.name), artifact.text);
  const common = ['--manifest', manifest, '--preflight', report, '--threshold', '0.7'];
  const run = (values: string[]) => spawnSync(process.execPath, [join(bundle, 'reviewPreflight.js'), ...values],
    { timeout: 30_000, encoding: 'utf8' });
  expect(run(['prepare', ...common, '--output', queue]).status).toBe(0);
  expect(readFileSync(queue, 'utf8')).toBe(prepared.text);
  expect(run(['prepare', ...common, '--output', queue]).status).toBe(1);
  const args = [...common, '--queue', queue, '--output', audit];
  expect(run(['audit', ...args]).status).toBe(2);
  expect(run(['verify', ...args]).status).toBe(2);
  const oldAudit = readFileSync(audit, 'utf8');
  writeFileSync(queue, encode(disposition(prepared.queue)));
  expect(run(['verify', ...args]).status).toBe(1);
  expect(run(['audit', ...args]).status).toBe(1);
  expect(readFileSync(audit, 'utf8')).toBe(oldAudit);
  const final = join(root, 'final.json');
  const finalArgs = [...common, '--queue', queue, '--output', final];
  const completed = run(['audit', ...finalArgs]);
  expect(completed.status, completed.stderr).toBe(0);
  expect(run(['verify', ...finalArgs]).status).toBe(0);
  expect(completed.stdout + completed.stderr).not.toContain('Private pair rationale');
  expect(completed.stdout + completed.stderr).not.toContain('Private case rationale');
  expect(completed.stdout + completed.stderr).not.toContain(root);
  expect(JSON.parse(completed.stdout).release_approved).toBe(false);
});
