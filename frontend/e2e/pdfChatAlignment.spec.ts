import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildIndex, type Corpus, type Passage } from '../src/pdfChatCore';
import { alignmentCandidates, alignmentPage, analyzeAlignment, appendAlignment,
  filterAlignments, moveAlignment, nextAlignmentId, normalizeAlignmentGroup, normalizeAlignmentLedger,
  removeAlignment, replaceAlignment, summarizeAlignment, toggleAlignmentSource, updateAlignmentReview,
  validateAlignmentLedger, MAX_ALIGNMENT_GROUPS, MAX_ALIGNMENT_SIDE, MAX_ALIGNMENT_TITLE,
  MAX_ALIGNMENT_NOTE, ALIGNMENT_CANDIDATE_PAGE, ALIGNMENT_RESULT_PAGE, type AlignmentGroup,
  type AlignmentLedger } from '../src/pdfChatAlignment';
import { readAlignmentFile, serializeAlignmentReport, verifyAlignmentReport, verifyAttachedAlignmentReport,
  MAX_ALIGNMENT_REPORT_BYTES } from '../src/pdfChatAlignmentExchange';
import { serializeCorpusSnapshot } from '../src/pdfChatCorpusSnapshot';

const original: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Application fee: INR 500',
    position: { x0: 12, x1: 180, y: 700, height: 12 } },
  { role: 'original', page: 1, ordinal: 2, text: 'Rural applicants must submit a certificate' },
  { role: 'original', page: 1, ordinal: 3, text: 'A residence certificate is required' },
  { role: 'original', page: 2, ordinal: 1, text: 'A residence certificate is required' },
  { role: 'original', page: 2, ordinal: 2, text: 'Unrelated private original text' },
];
const revised: Passage[] = [
  { role: 'revised', page: 1, ordinal: 1, text: 'Application fee: INR 350' },
  { role: 'revised', page: 1, ordinal: 2, text: 'A residence certificate is required' },
  { role: 'revised', page: 2, ordinal: 1, text: 'Rural applicants may provide proof of residence' },
  { role: 'revised', page: 2, ordinal: 2, text: 'Unrelated private revised text' },
];
function corpus(rows: Passage[], patch: Partial<Corpus> = {}): Corpus {
  return { passages: rows, pageCount: 2, processedPages: 2,
    missingPages: [], limitedPages: [], limited: false, ...patch };
}
const corpora = { original: corpus(original), revised: corpus(revised) };
const index = buildIndex([...original, ...revised]);
const pins = { original: 'a'.repeat(64), revised: 'b'.repeat(64) };
const snapshot = serializeCorpusSnapshot(pins, corpora);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
function group(id: string, left: string[], right: string[], title = id): AlignmentGroup {
  return { id, title, original: left, revised: right, status: 'unreviewed', note: '' };
}
const groups: AlignmentLedger = [
  { ...group('fee', ['original:1:1'], ['revised:1:1'], 'Application fee review'),
    status: 'reviewed_manually', note: 'Personal fee note.' },
  group('certificate', ['original:2:1', 'original:1:3'], ['revised:1:2'], 'Certificate wording'),
  group('qualification', ['original:1:2'], ['revised:2:1'], 'Applicant qualification'),
  { ...group('one-sided', ['original:1:3'], [], 'Additional selected original excerpt'),
    status: 'needs_followup', note: 'Look at the full revised notice.' },
];
const analyzed = () => analyzeAlignment(index, groups);
const report = () => serializeAlignmentReport(index, pins, corpora, groups, analyzed(), true);

test('manual group comparison preserves exact source identities, repeated occurrences and role separation', () => {
  const rows = analyzed();
  expect(rows.map(row => row.state)).toEqual(['both_selected_different_multiset', 'both_selected_different_multiset',
    'both_selected_different_multiset', 'original_selection_only']);
  expect(rows[1].original.map(row => row.id)).toEqual(['original:1:3', 'original:2:1']);
  expect(rows[1].observations).toEqual([{ text: 'A residence certificate is required',
    originalIds: ['original:1:3', 'original:2:1'], revisedIds: ['revised:1:2'],
    identicalOccurrenceCount: 1, originalOnlyCount: 1, revisedOnlyCount: 0 }]);
  expect(rows[1].literalDiff).toBeNull();
  expect(rows[1].literalDiffStatus).toBe('not_single_pair');
  expect(rows[1].original[0].sharedGroupCount).toBe(2);
  expect(rows[3].original[0].sharedGroupCount).toBe(2);
  expect(rows[3].revised).toEqual([]);
  expect(rows[3].revisedOnlyOccurrences).toBe(0);
  expect(rows[3].state).toBe('original_selection_only');
  expect(summarizeAlignment(rows)).toEqual({
    groups: 4, originalSelections: 5, revisedSelections: 3, distinctOriginal: 4,
    distinctRevised: 3, reusedFragments: 1,
    states: { both_selected_same_multiset: 0, both_selected_different_multiset: 3,
      original_selection_only: 1, revised_selection_only: 0 },
    statuses: { unreviewed: 2, reviewed_manually: 1, needs_followup: 1 },
  });
});
test('single-pair token comparison never changes exact source text or interprets amounts', () => {
  const fee = analyzed()[0];
  expect(fee.literalDiffStatus).toBe('available');
  expect(fee.literalDiff?.identical).toBe(false);
  expect(fee.literalDiff?.originalSegments.map(row => row.text).join('')).toBe(original[0].text);
  expect(fee.literalDiff?.revisedSegments.map(row => row.text).join('')).toBe(revised[0].text);
  expect(fee.changedNumeric?.original.map(row => row.text)).toEqual(['500']);
  expect(fee.changedNumeric?.revised.map(row => row.text)).toEqual(['350']);
  const identical = analyzeAlignment(index, [group('same', ['original:1:3'], ['revised:1:2'])])[0];
  expect(identical.state).toBe('both_selected_same_multiset');
  expect(identical.literalDiff?.identical).toBe(true);
});
test('matching multisets can appear in different physical order without automatically pairing passages', () => {
  const rows: Passage[] = [
    { role: 'original', page: 1, ordinal: 1, text: 'A' },
    { role: 'original', page: 1, ordinal: 2, text: 'B' },
    { role: 'revised', page: 1, ordinal: 1, text: 'B' },
    { role: 'revised', page: 1, ordinal: 2, text: 'A' },
  ];
  const result = analyzeAlignment(buildIndex(rows), [group('reordered',
    ['original:1:1', 'original:1:2'], ['revised:1:1', 'revised:1:2'])])[0];
  expect(result.state).toBe('both_selected_same_multiset');
  expect(result.identicalOccurrences).toBe(2);
  expect(result.literalDiffStatus).toBe('not_single_pair');
  expect(result.observations.map(row => row.originalIds)).toEqual([['original:1:1'], ['original:1:2']]);
  expect(result.observations.map(row => row.revisedIds)).toEqual([['revised:1:2'], ['revised:1:1']]);
});
test('one-sided selection is permitted and a large token pair does not erase selected evidence', () => {
  const one = analyzeAlignment(index, [group('one', [], ['revised:1:1'])])[0];
  expect(one.state).toBe('revised_selection_only');
  expect(one.original).toEqual([]);
  const rows: Passage[] = [
    { role: 'original', page: 1, ordinal: 1, text: '!'.repeat(600) },
    { role: 'revised', page: 1, ordinal: 1, text: '?'.repeat(600) },
  ];
  const long = analyzeAlignment(buildIndex(rows), [group('large', ['original:1:1'], ['revised:1:1'])])[0];
  expect(long.literalDiffStatus).toBe('token_budget');
  expect(long.literalDiff).toBeNull();
  expect(long.original[0].source.text).toBe(rows[0].text);
  expect(long.state).toBe('both_selected_different_multiset');
});
for (const [name, mutate] of [
  ['invalid group ID', (x: any) => x.id = '../secret'],
  ['blank title', (x: any) => x.title = ''],
  ['oversized title', (x: any) => x.title = 'x'.repeat(MAX_ALIGNMENT_TITLE + 1)],
  ['multiline title', (x: any) => x.title = 'a\nb'],
  ['untrimmed title', (x: any) => x.title = ' title '],
  ['empty group', (x: any) => { x.original = []; x.revised = []; }],
  ['source role swap', (x: any) => x.original = ['revised:1:1']],
  ['invalid page', (x: any) => x.original = ['original:81:1']],
  ['leading zero page', (x: any) => x.original = ['original:01:1']],
  ['invalid ordinal', (x: any) => x.original = ['original:1:0']],
  ['duplicate selection', (x: any) => x.original = ['original:1:1', 'original:1:1']],
  ['over budget', (x: any) => x.original = Array.from({ length: MAX_ALIGNMENT_SIDE + 1 }, (_, i) => 'original:1:' + (i + 1))],
  ['invalid review', (x: any) => x.status = 'officially_verified'],
  ['oversized note', (x: any) => x.note = 'x'.repeat(MAX_ALIGNMENT_NOTE + 1)],
  ['control character', (x: any) => x.note = 'a' + String.fromCharCode(0) + 'b'],
  ['unpaired surrogate', (x: any) => x.note = String.fromCharCode(0xd800)],
  ['extra claim', (x: any) => x.authority_verified = true],
] as const) {
  test('group parser rejects ' + name, () => {
    const changed = structuredClone(groups[0]);
    mutate(changed);
    expect(() => normalizeAlignmentGroup(changed)).toThrow();
  });
}
test('source selections must exist and cannot refer to duplicated physical identities', () => {
  expect(() => validateAlignmentLedger(index, [group('missing', ['original:1:99'], [])])).toThrow();
  expect(() => analyzeAlignment(buildIndex([...original, original[0], ...revised]), groups)).toThrow();
  expect(() => analyzeAlignment(buildIndex(revised), groups)).toThrow();
  expect(() => normalizeAlignmentLedger([groups[0], groups[0]])).toThrow();
  expect(() => normalizeAlignmentLedger([])).toThrow();
  expect(normalizeAlignmentLedger([], true)).toEqual([]);
});
test('group budget, movement, source selection and editing do not mutate previous state', () => {
  const existing = Array.from({ length: MAX_ALIGNMENT_GROUPS }, (_, i) =>
    group('group-' + (i + 1), ['original:1:1'], []));
  expect(validateAlignmentLedger(index, existing)).toHaveLength(MAX_ALIGNMENT_GROUPS);
  expect(() => appendAlignment(index, existing, group('overflow', ['original:1:1'], []))).toThrow();
  const input = [group('group-1', ['original:1:1'], ['revised:1:1']),
    group('group-2', ['original:1:3'], ['revised:1:2'])];
  const before = encode(input);
  expect(nextAlignmentId(input)).toBe('group-3');
  expect(moveAlignment(input, 'group-2', -1).map(row => row.id)).toEqual(['group-2', 'group-1']);
  expect(removeAlignment(input, 'group-1')).toEqual([input[1]]);
  expect(encode(input)).toBe(before);
  expect(toggleAlignmentSource(['original:2:1'], 'original:1:2', 'original')).toEqual(['original:1:2', 'original:2:1']);
  expect(toggleAlignmentSource(['original:1:1'], 'original:1:1', 'original')).toEqual([]);
  expect(() => toggleAlignmentSource([], 'revised:1:1', 'original')).toThrow();
  expect(() => moveAlignment(input, 'group-1', -1)).toThrow();
  expect(() => removeAlignment(input, 'absent')).toThrow();
});
test('changes to topic or selected evidence reset saved review; mere source order or group movement does not', () => {
  const first = groups[0];
  expect(replaceAlignment(index, groups, { ...first, title: 'New topic' })[0]).toMatchObject({ status: 'unreviewed', note: '' });
  expect(replaceAlignment(index, groups, { ...first, original: ['original:1:1', 'original:1:2'] })[0])
    .toMatchObject({ status: 'unreviewed', note: '' });
  expect(replaceAlignment(index, groups, first)[0]).toEqual(first);
  const reviewed = updateAlignmentReview(index, groups, 'certificate', { status: 'reviewed_manually', note: 'Saved note' });
  expect(replaceAlignment(index, reviewed, { ...reviewed[1], original: [...reviewed[1].original].reverse() })[1])
    .toMatchObject({ status: 'reviewed_manually', note: 'Saved note' });
  expect(moveAlignment(reviewed, 'certificate', -1)[0].note).toBe('Saved note');
  expect(() => updateAlignmentReview(index, groups, 'missing', { note: 'No' })).toThrow();
  expect(() => updateAlignmentReview(index, groups, 'fee', { original: [] } as any)).toThrow();
});
test('candidate filters use physical scope and literal wording while selected identities remain available', () => {
  expect(alignmentCandidates(index, { role: 'original', page: 2, keyword: 'CERTIFICATE', hideSelected: false }, []))
    .toEqual([original[3]]);
  expect(alignmentCandidates(index, { role: 'original', keyword: 'certificate', hideSelected: true }, ['original:1:3']))
    .toEqual([original[1], original[3]]);
  expect(alignmentCandidates(index, { role: 'revised', keyword: 'INR 500', hideSelected: false }, [])).toEqual([]);
  expect(() => alignmentCandidates(index, { role: 'original', page: 81, keyword: '', hideSelected: false }, [])).toThrow();
  const rows = analyzed();
  expect(filterAlignments(rows, { state: 'original_selection_only', status: 'needs_followup', keyword: 'ADDITIONAL' })
    .map(row => row.group.id)).toEqual(['one-sided']);
  expect(alignmentPage([...rows, ...rows], 99, ALIGNMENT_RESULT_PAGE)).toMatchObject({ page: 2, pages: 2, total: 8 });
  expect(alignmentPage([], 1, ALIGNMENT_CANDIDATE_PAGE)).toEqual({ rows: [], page: 1, pages: 1, total: 0 });
  expect(() => alignmentPage(rows, 0, ALIGNMENT_RESULT_PAGE)).toThrow();
});
test('canonical report contains selected excerpts only and replays against exact complete native snapshot', async () => {
  const text = await report(), raw = JSON.parse(text);
  expect(raw.authority_verified).toBe(false);
  expect(raw.snapshot_sha256).toBe(sha(snapshot));
  expect(raw.results[0].original[0]).toMatchObject({ id: 'original:1:1', native_text: original[0].text,
    physical_page: 1, fragment_ordinal: 1, position: original[0].position });
  expect(raw.results[0].literal_diff.changed_numeric.original.map((row: any) => row.text)).toEqual(['500']);
  expect(raw.results[1].literal_diff).toBeNull();
  expect(raw.groups[0].note).toBe(groups[0].note);
  expect(text).not.toContain(original[4].text);
  expect(text).not.toContain(revised[3].text);
  const verified = await verifyAlignmentReport(text, snapshot);
  expect(verified.groups).toEqual(normalizeAlignmentLedger(groups));
  expect(verified.results).toEqual(analyzed());
  expect(verified.summary).toEqual(summarizeAlignment(analyzed()));
  expect(await verifyAttachedAlignmentReport(text, pins, corpora, index)).toEqual(verified);
  expect(await report()).toBe(text);
  await expect(serializeAlignmentReport(index, pins, corpora, groups, analyzed(), false)).rejects.toThrow();
});
for (const [name, mutate] of [
  ['authority flag', (x: any) => x.authority_verified = true],
  ['source hash', (x: any) => x.source_coverage[0].sha256 = 'c'.repeat(64)],
  ['snapshot hash', (x: any) => x.snapshot_sha256 = 'd'.repeat(64)],
  ['quote', (x: any) => x.results[0].original[0].native_text = 'Invented fee'],
  ['physical page', (x: any) => x.results[0].original[0].physical_page = 2],
  ['geometry', (x: any) => x.results[0].original[0].position.y = 1],
  ['reuse count', (x: any) => x.results[1].original[0].shared_group_count = 10],
  ['source state', (x: any) => x.results[3].state = 'both_selected_same_multiset'],
  ['exact wording count', (x: any) => x.results[1].observations[0].identical_occurrences = 2],
  ['token count', (x: any) => x.results[0].literal_diff.same_tokens = 999],
  ['numeric marker', (x: any) => x.results[0].literal_diff.changed_numeric.original[0].text = '999'],
  ['review status', (x: any) => x.groups[0].status = 'needs_followup'],
  ['selection', (x: any) => x.groups[0].original = ['original:1:2']],
  ['summary', (x: any) => x.summary.groups = 1],
  ['missing result', (x: any) => x.results.pop()],
] as const) {
  test('report replay rejects tampered ' + name, async () => {
    const raw = JSON.parse(await report()); mutate(raw);
    await expect(verifyAlignmentReport(encode(raw), snapshot)).rejects.toThrow();
  });
}
test('human-authored note is not an authenticated record even when source replay passes', async () => {
  const raw = JSON.parse(await report());
  raw.groups[0].note = 'Different personal note.';
  const result = await verifyAlignmentReport(encode(raw), snapshot);
  expect(result.groups[0].note).toBe('Different personal note.');
  expect(result.results[0].original[0].source.text).toBe(original[0].text);
});
test('changed extraction outside selected excerpts invalidates report binding', async () => {
  const text = await report();
  const changed = { ...corpora, original: corpus([...original.slice(0, 4),
    { ...original[4], text: 'Changed unrelated text' }]) };
  await expect(verifyAlignmentReport(text, serializeCorpusSnapshot(pins, changed))).rejects.toThrow();
  await expect(verifyAlignmentReport(text, serializeCorpusSnapshot({ ...pins, original: 'c'.repeat(64) }, corpora))).rejects.toThrow();
  await expect(verifyAlignmentReport(text, serializeCorpusSnapshot({ original: pins.original }, { original: corpora.original }))).rejects.toThrow();
});
test('stale displayed groups, observations or altered selected geometry cannot be exported', async () => {
  const displayed = analyzed();
  await expect(serializeAlignmentReport(index, pins, corpora, groups, displayed.slice(1), true)).rejects.toThrow();
  const forged = structuredClone(displayed); forged[0].original[0].source.text = 'invented';
  await expect(serializeAlignmentReport(index, pins, corpora, groups, forged, true)).rejects.toThrow();
  const noteChanged = updateAlignmentReview(index, groups, 'fee', { note: 'New note' });
  await expect(serializeAlignmentReport(index, pins, corpora, noteChanged, displayed, true)).rejects.toThrow();
  const other = buildIndex([{ ...original[0], position: { ...original[0].position!, y: 12 } }, ...original.slice(1), ...revised]);
  await expect(verifyAttachedAlignmentReport(await report(), pins, corpora, other)).rejects.toThrow();
});
test('file and canonical replay guards reject malformed UTF-8, duplicate members and oversized content', async () => {
  const text = await report();
  expect(await readAlignmentFile(new File([text], 'alignment.json'))).toBe(text);
  await expect(readAlignmentFile(new File([], 'empty.json'))).rejects.toThrow();
  await expect(readAlignmentFile(new File([new Uint8Array([0xff])], 'bad.json'))).rejects.toThrow();
  await expect(readAlignmentFile(new File(['x'.repeat(MAX_ALIGNMENT_REPORT_BYTES + 1)], 'large.json'))).rejects.toThrow();
  await expect(verifyAlignmentReport(text.trim(), snapshot)).rejects.toThrow();
  await expect(verifyAlignmentReport(text.replace('"version": 1', '"version": 0, "version": 1'), snapshot)).rejects.toThrow();
});
test('offline alignment CLI replays without printing private topics, notes or source fragments', async ({}, info) => {
  test.setTimeout(120_000);
  const root = info.outputPath('alignment-cli'), bundle = join(root, 'bundle');
  mkdirSync(root, { recursive: true });
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build',
    '--ssr', 'evaluation/verifyAlignment.ts', '--outDir', bundle], { timeout: 60_000, stdio: 'pipe' });
  writeFileSync(join(bundle, 'package.json'), '{"type":"module"}\n');
  const reportFile = join(root, 'alignment.json'), snapshotFile = join(root, 'snapshot.json');
  const text = await report();
  writeFileSync(reportFile, text); writeFileSync(snapshotFile, snapshot);
  const run = (args: string[]) => spawnSync(process.execPath, [join(bundle, 'verifyAlignment.js'), ...args],
    { timeout: 30_000, encoding: 'utf8' });
  expect(run(['--help']).status).toBe(0);
  const args = ['--report', reportFile, '--snapshot', snapshotFile];
  const result = run(args);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ consistent: true, authority_verified: false,
    report_sha256: sha(text), snapshot_sha256: sha(snapshot), summary: summarizeAlignment(analyzed()) });
  for (const secret of [root, groups[0].title, groups[0].note, original[0].text, 'original:1:1']) {
    expect(result.stdout + result.stderr).not.toContain(secret);
  }
  writeFileSync(reportFile, text.replace('INR 500', 'INR 999'));
  const invalid = run(args);
  expect(invalid.status).toBe(1);
  expect(invalid.stdout).toBe('');
  expect(invalid.stderr).not.toContain(root);
  expect(run([...args, '--extra']).status).toBe(1);
});
