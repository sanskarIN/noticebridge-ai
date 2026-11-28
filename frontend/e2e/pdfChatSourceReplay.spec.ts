import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { buildIndex, type Corpus, type Passage, type Role } from '../src/pdfChatCore';
import { serializeCorpusSnapshot } from '../src/pdfChatCorpusSnapshot';
import { blankChecklistReviews, runChecklist, type ChecklistPlan } from '../src/pdfChatChecklist';
import { serializeChecklistReport } from '../src/pdfChatChecklistExchange';
import { compareExtractedFragments, compareExtractionCoverage, replayNativeSources,
  verifyNativeSourceReplay, MAX_REPLAY_PDF_BYTES, MAX_SOURCE_REPLAY_REPORT_BYTES,
  type Extractor, type ReplayProgress } from '../src/pdfChatSourceReplay';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const firstBytes = '%PDF-fixture-original';
const secondBytes = '%PDF-fixture-revised';
const original = new File([firstBytes], 'private-original.pdf', { type: 'application/pdf' });
const revised = new File([secondBytes], 'private-revised.pdf', { type: 'application/pdf' });
const pins = { original: sha(firstBytes), revised: sha(secondBytes) };
const position = { x0: 12, x1: 100, y: 500, height: 12 };
const passages: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Application fee: INR 500', position },
  { role: 'original', page: 1, ordinal: 2, text: 'Private unrelated source fragment' },
  { role: 'revised', page: 1, ordinal: 1, text: 'Application fee: INR 350' },
];
function corpus(rows: Passage[], patch: Partial<Corpus> = {}): Corpus {
  return { passages: rows, pageCount: 1, processedPages: 1,
    missingPages: [], limitedPages: [], limited: false, ...patch };
}
const corpora = { original: corpus(passages.slice(0, 2)), revised: corpus(passages.slice(2)) };
const snapshot = serializeCorpusSnapshot(pins, corpora);
const files = { original, revised };
function fixtureExtractor(overrides: Partial<Record<Role, Corpus>> = {}) {
  const calls: Role[] = [];
  const extract: Extractor = async (file, role, signal) => {
    signal.throwIfAborted();
    calls.push(role);
    expect(file.name).toBe('source.pdf');
    expect(await file.text()).toBe(role === 'original' ? firstBytes : secondBytes);
    return structuredClone(overrides[role] ?? corpora[role]);
  };
  return { extract, calls };
}
const signal = () => new AbortController().signal;
const plan: ChecklistPlan = [{ id: 'fee', question: 'Application fee?', scope: 'both', includeContext: false }];
async function checklist() {
  const index = buildIndex(passages);
  return serializeChecklistReport(index, pins, corpora, plan, blankChecklistReviews(plan),
    runChecklist(index, corpora, plan), true);
}

test('exact native replay independently hashes and reextracts each role, without exposing private text', async () => {
  const { extract, calls } = fixtureExtractor();
  const updates: ReplayProgress[] = [];
  const result = await replayNativeSources(snapshot, files, { signal: signal(), extract, onProgress: p => updates.push(p) });
  expect(calls).toEqual(['original', 'revised']);
  expect(updates).toEqual(['original', 'revised'].flatMap(role =>
    ['hashing', 'extracting', 'compared'].map(stage => ({ role, stage }))));
  expect(result.report).toMatchObject({
    format: 'noticebridge-native-source-replay', version: 1, status: 'exact_replay',
    authority_verified: false, extraction_completeness_verified: false, answer_accuracy_verified: false,
    source_roles_match: true, all_pdf_bytes_match: true, all_native_extractions_match: true,
    snapshot_sha256: sha(snapshot), checklist: null,
  });
  expect(result.report.sources.map(row => row.state)).toEqual(['exact_replay', 'exact_replay']);
  expect(result.report.sources[0]).toMatchObject({
    expected_sha256: pins.original, observed_sha256: pins.original, byte_count: original.size,
    coverage: { matches: true },
    fragments: { expected_fragments: 2, observed_fragments: 2, identical_fragments: 2,
      changed_text: 0, changed_geometry: 0, expected_only: 0, observed_only: 0 },
  });
  for (const secret of ['private-original.pdf', 'private-revised.pdf', ...passages.map(row => row.text), firstBytes, secondBytes]) {
    expect(result.text).not.toContain(secret);
  }
  const repeated = await verifyNativeSourceReplay(result.text, snapshot, files, { signal: signal(), extract });
  expect(repeated.text).toBe(result.text);
  expect(calls).toEqual(['original', 'revised', 'original', 'revised']);
});
test('filename and MIME metadata are not treated as PDF identity', async () => {
  const { extract } = fixtureExtractor();
  const a = await replayNativeSources(snapshot, files, { signal: signal(), extract });
  const b = await replayNativeSources(snapshot, {
    original: new File([firstBytes], 'renamed.PDF', { type: 'application/octet-stream' }),
    revised: new File([secondBytes], 'another.pdf'),
  }, { signal: signal(), extract });
  expect(b.text).toBe(a.text);
});
test('role swaps and mismatched PDF bytes never invoke native extraction', async () => {
  const { extract, calls } = fixtureExtractor();
  const result = await replayNativeSources(snapshot, { original: revised, revised: original }, { signal: signal(), extract });
  expect(calls).toEqual([]);
  expect(result.report).toMatchObject({ source_roles_match: true, all_pdf_bytes_match: false,
    all_native_extractions_match: false, status: 'not_reproduced' });
  expect(result.report.sources.map(row => row.state)).toEqual(['different_pdf_bytes', 'different_pdf_bytes']);
  expect(result.report.sources.every(row => row.fragments === null && row.coverage === null)).toBe(true);
});
test('a missing role and an unexpected extra role remain explicit', async () => {
  const { extract, calls } = fixtureExtractor();
  const missing = await replayNativeSources(snapshot, { original }, { signal: signal(), extract });
  expect(missing.report.sources[1]).toEqual({
    role: 'revised', state: 'missing_pdf', expected_sha256: pins.revised, observed_sha256: null,
    byte_count: null, coverage: null, fragments: null,
  });
  expect(missing.report.source_roles_match).toBe(false);
  const extra = await replayNativeSources(serializeCorpusSnapshot({ original: pins.original }, { original: corpora.original }),
    files, { signal: signal(), extract });
  expect(extra.report.sources[1]).toMatchObject({ role: 'revised', state: 'unexpected_pdf',
    expected_sha256: null, observed_sha256: pins.revised, byte_count: revised.size, coverage: null, fragments: null });
  expect(extra.report.status).toBe('not_reproduced');
  expect(calls).toEqual(['original', 'original']);
});
test('no PDFs selected cannot qualify a saved snapshot', async () => {
  const { extract, calls } = fixtureExtractor();
  const result = await replayNativeSources(snapshot, {}, { signal: signal(), extract });
  expect(result.report.sources.map(row => row.state)).toEqual(['missing_pdf', 'missing_pdf']);
  expect(result.report.all_pdf_bytes_match).toBe(false);
  expect(result.report.all_native_extractions_match).toBe(false);
  expect(calls).toEqual([]);
});
test('same bytes but altered text and geometry are detected independently', async () => {
  const changed = corpus([{ ...passages[0], text: 'Application fee: INR 999',
    position: { ...position, x0: 14 } }, passages[1]]);
  const { extract } = fixtureExtractor({ original: changed });
  const result = await replayNativeSources(snapshot, files, { signal: signal(), extract });
  expect(result.report.all_pdf_bytes_match).toBe(true);
  expect(result.report.all_native_extractions_match).toBe(false);
  expect(result.report.sources[0]).toMatchObject({
    state: 'different_extraction', coverage: { matches: true },
    fragments: { identical_fragments: 1, changed_text: 1, changed_geometry: 1, expected_only: 0, observed_only: 0 },
  });
  expect(result.text).not.toContain('INR 999');
});
test('a changed physical fragment identity is not counted as a changed text at the same identity', () => {
  const expected = corpora.original;
  const observed = corpus([passages[0], { ...passages[1], ordinal: 3 }]);
  expect(compareExtractedFragments(expected, observed)).toEqual({
    expected_fragments: 2, observed_fragments: 2, identical_fragments: 1,
    changed_text: 0, changed_geometry: 0, expected_only: 1, observed_only: 1,
  });
  expect(() => compareExtractedFragments(expected, corpus([passages[0], passages[0]]))).toThrow();
});
test('geometry presence matters and object property order does not affect exact replay', async () => {
  const { position: _removed, ...withoutPosition } = passages[0];
  const { extract } = fixtureExtractor({ original: corpus([withoutPosition, passages[1]]) });
  const different = await replayNativeSources(snapshot, files, { signal: signal(), extract });
  expect(different.report.sources[0].fragments?.changed_geometry).toBe(1);
  expect(different.report.sources[0].fragments?.changed_text).toBe(0);
  const reordered = { height: 12, y: 500, x1: 100, x0: 12 };
  const exact = fixtureExtractor({ original: corpus([{ ...passages[0], position: reordered }, passages[1]]) });
  expect((await replayNativeSources(snapshot, files, { signal: signal(), extract: exact.extract })).report.status).toBe('exact_replay');
});
test('coverage differences invalidate replay even if every displayed fragment is identical', async () => {
  const changed = corpus(corpora.original.passages, { pageCount: 2, limited: true });
  const { extract } = fixtureExtractor({ original: changed });
  const result = await replayNativeSources(snapshot, files, { signal: signal(), extract });
  expect(result.report.sources[0]).toMatchObject({ state: 'different_extraction',
    fragments: { identical_fragments: 2 }, coverage: { matches: false,
      expected_physical_pages: 1, observed_physical_pages: 2, observed_limited: true } });
  const a = corpus([], { pageCount: 2, processedPages: 2, missingPages: [1, 2], limited: true, limitedPages: [1] });
  const b = { ...a, limitedPages: [2] };
  expect(compareExtractionCoverage(a, b)).toMatchObject({ matches: false,
    expected_missing_pages: [1, 2], observed_missing_pages: [1, 2],
    expected_limited_pages: [1], observed_limited_pages: [2] });
});
test('exact replay of a limited empty native extraction does not certify completeness', async () => {
  const empty = corpus([], { pageCount: 2, processedPages: 1, missingPages: [1], limitedPages: [1], limited: true });
  const single = serializeCorpusSnapshot({ original: pins.original }, { original: empty });
  const { extract } = fixtureExtractor({ original: empty });
  const result = await replayNativeSources(single, { original }, { signal: signal(), extract });
  expect(result.report).toMatchObject({ status: 'exact_replay', extraction_completeness_verified: false });
  expect(result.report.sources[0]).toMatchObject({ coverage: { matches: true, observed_limited: true },
    fragments: { expected_fragments: 0, observed_fragments: 0, identical_fragments: 0 } });
});
for (const [name, altered] of [
  ['role swap', corpus([{ ...passages[0], role: 'revised' }, passages[1]])],
  ['duplicate identity', corpus([passages[0], passages[0]])],
  ['out of range page', corpus([{ ...passages[0], page: 2 }])],
  ['invalid coverage', corpus(corpora.original.passages, { processedPages: 2 })],
  ['nonfinite geometry', corpus([{ ...passages[0], position: { ...position, x0: Infinity } }])],
] as const) {
  test('invalid extracted corpus is explicitly unavailable: ' + name, async () => {
    const { extract } = fixtureExtractor({ original: altered });
    const result = await replayNativeSources(snapshot, files, { signal: signal(), extract });
    expect(result.report.sources[0]).toMatchObject({ state: 'extraction_failed', coverage: null, fragments: null });
    expect(result.report.sources[1].state).toBe('exact_replay');
    expect(result.report.all_pdf_bytes_match).toBe(true);
    expect(result.report.status).toBe('not_reproduced');
  });
}
test('extractor errors are not leaked and do not erase another successful role', async () => {
  const extract: Extractor = async (_file, role) => {
    if (role === 'original') throw new Error('Private failure /secret/private.pdf');
    return corpora.revised;
  };
  const result = await replayNativeSources(snapshot, files, { signal: signal(), extract });
  expect(result.report.sources.map(row => row.state)).toEqual(['extraction_failed', 'exact_replay']);
  expect(result.text).not.toContain('Private failure');
  expect(result.text).not.toContain('/secret');
});
test('checklist replay distinguishes saved extraction consistency from actual PDF replay', async () => {
  const { extract } = fixtureExtractor();
  const report = await checklist();
  const valid = await replayNativeSources(snapshot, files, { signal: signal(), extract, checklistReport: report });
  expect(valid.report.checklist).toMatchObject({ report_sha256: sha(report),
    snapshot_replay_matches: true, actual_pdf_replay_matches: true, summary: { questions: 1, citations: 2 } });
  expect(valid.report.status).toBe('exact_replay');
  const missing = await replayNativeSources(snapshot, { original }, { signal: signal(), extract, checklistReport: report });
  expect(missing.report.checklist).toMatchObject({ snapshot_replay_matches: true, actual_pdf_replay_matches: false });
  expect(missing.report.status).toBe('not_reproduced');
  const forged = await replayNativeSources(snapshot, files, { signal: signal(), extract,
    checklistReport: report.replace('INR 500', 'INR 999') });
  expect(forged.report.all_native_extractions_match).toBe(true);
  expect(forged.report.checklist).toMatchObject({ snapshot_replay_matches: false, actual_pdf_replay_matches: false, summary: null });
  expect(forged.report.status).toBe('not_reproduced');
  expect(forged.text).not.toContain('INR 999');
});
test('aborted replay stops before extraction or prevents subsequent role work', async () => {
  const controller = new AbortController(), { extract, calls } = fixtureExtractor();
  controller.abort();
  await expect(replayNativeSources(snapshot, files, { signal: controller.signal, extract })).rejects.toThrow();
  expect(calls).toEqual([]);
  const next = new AbortController();
  await expect(replayNativeSources(snapshot, files, { signal: next.signal, extract,
    onProgress: update => { if (update.role === 'original' && update.stage === 'compared') next.abort(); } })).rejects.toThrow();
  expect(calls).toEqual(['original']);
});
test('abort during extraction is not converted into a saved extraction failure', async () => {
  const controller = new AbortController();
  const extract: Extractor = async () => { controller.abort(); throw new Error('cancelled'); };
  await expect(replayNativeSources(snapshot, files, { signal: controller.signal, extract })).rejects.toThrow();
});
test('noncanonical, oversized and incorrectly typed inputs reject before extraction', async () => {
  const { extract, calls } = fixtureExtractor();
  for (const invalid of [snapshot.trim(), snapshot.replace('"version": 1', '"version": 0, "version": 1'), '{}']) {
    await expect(replayNativeSources(invalid, files, { signal: signal(), extract })).rejects.toThrow();
  }
  for (const bad of [new File([], 'empty.pdf'), new File(['x'], 'not.pdf.txt'),
    new File([new Uint8Array(MAX_REPLAY_PDF_BYTES + 1)], 'large.pdf')]) {
    await expect(replayNativeSources(snapshot, { original: bad }, { signal: signal(), extract })).rejects.toThrow();
  }
  await expect(replayNativeSources(snapshot, { ...files, other: original } as any, { signal: signal(), extract })).rejects.toThrow();
  await expect(verifyNativeSourceReplay('x'.repeat(MAX_SOURCE_REPLAY_REPORT_BYTES + 1), snapshot, files,
    { signal: signal(), extract })).rejects.toThrow();
  expect(calls).toEqual([]);
});
test('candidate replay report is never trusted and must match exact bytes after fresh replay', async () => {
  const { extract } = fixtureExtractor();
  const result = await replayNativeSources(snapshot, files, { signal: signal(), extract });
  for (const changed of [result.text.trim(), result.text.replace('"authority_verified": false', '"authority_verified": true'),
    result.text.replace('"identical_fragments": 2', '"identical_fragments": 99'),
    result.text.replace(pins.original, 'd'.repeat(64))]) {
    await expect(verifyNativeSourceReplay(changed, snapshot, files, { signal: signal(), extract })).rejects.toThrow();
  }
  await expect(verifyNativeSourceReplay(result.text, snapshot, { original }, { signal: signal(), extract })).rejects.toThrow();
  const failure = await replayNativeSources(snapshot, { original }, { signal: signal(), extract });
  const replayedFailure = await verifyNativeSourceReplay(failure.text, snapshot, { original }, { signal: signal(), extract });
  expect(replayedFailure.report.status).toBe('not_reproduced');
});
