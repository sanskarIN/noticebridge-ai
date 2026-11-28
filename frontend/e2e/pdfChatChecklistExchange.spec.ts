import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { prepareChecklistReadingCopy, safeChecklistCsvCell } from '../src/pdfChatChecklistReadingCopy';
import { compareChecklistRuns, replayChecklistComparison } from '../src/pdfChatChecklistComparison';
import { buildIndex, type Corpus, type Passage } from '../src/pdfChatCore';
import { blankChecklistReviews, runChecklist, updateChecklistReview, type ChecklistPlan } from '../src/pdfChatChecklist';
import { serializeCorpusSnapshot } from '../src/pdfChatCorpusSnapshot';
import { emptyChecklistFromTemplate, parseChecklistTemplate, readChecklistFile, serializeChecklistReport,
  serializeChecklistTemplate, verifyAttachedChecklistReport, verifyChecklistReport,
  MAX_CHECKLIST_REPORT_BYTES, MAX_CHECKLIST_TEMPLATE_BYTES } from '../src/pdfChatChecklistExchange';

const rows: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Application fee: INR 500' },
  { role: 'original', page: 1, ordinal: 2, text: 'Rural applicants' },
  { role: 'original', page: 1, ordinal: 3, text: 'Residence certificate required' },
  { role: 'revised', page: 1, ordinal: 1, text: 'Application fee: INR 350' },
  { role: 'revised', page: 1, ordinal: 2, text: 'Unrelated private text <script>😀</script>' },
];
const corpora = {
  original: { passages: rows.slice(0, 3), pageCount: 2, processedPages: 1,
    missingPages: [], limitedPages: [1], limited: true } satisfies Corpus,
  revised: { passages: rows.slice(3), pageCount: 1, processedPages: 1,
    missingPages: [], limitedPages: [], limited: false } satisfies Corpus,
};
const pins = { original: 'a'.repeat(64), revised: 'b'.repeat(64) };
const index = buildIndex(rows);
const items: ChecklistPlan = [
  { id: 'fee', question: 'Application fee?', scope: 'both', includeContext: false },
  { id: 'context', question: 'Rural residence certificate?', scope: 'original', includeContext: true },
  { id: 'refund', question: 'Refund policy?', scope: 'both', includeContext: false },
  { id: 'unavailable', question: 'Application fee on page 2?', scope: 'original', includeContext: false },
];
const results = runChecklist(index, corpora, items);
let reviews = blankChecklistReviews(items);
reviews = updateChecklistReview(items, reviews, 'fee', { status: 'reviewed_manually', note: 'Personal review <b>not evidence</b>.' });
reviews = updateChecklistReview(items, reviews, 'refund', { status: 'needs_followup', note: 'Consult the publication.' });
const snapshot = serializeCorpusSnapshot(pins, corpora);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const report = () => serializeChecklistReport(index, pins, corpora, items, reviews, results, true);

test('reusable template contains questions and explicit routing only, with no source fingerprint, evidence or note', () => {
  const text = serializeChecklistTemplate(items, true);
  expect(parseChecklistTemplate(text)).toEqual(items);
  expect(emptyChecklistFromTemplate(text)).toEqual({ items, reviews: blankChecklistReviews(items) });
  expect(JSON.parse(text).authority_verified).toBe(false);
  for (const secret of [pins.original, pins.revised, rows[0].text, rows[4].text, reviews[0].note, 'snapshot_sha256']) {
    expect(text).not.toContain(secret);
  }
  expect(() => serializeChecklistTemplate(items, false)).toThrow();
  expect(() => serializeChecklistTemplate([], true)).toThrow();
});
test('template parser rejects duplicate fields, noncanonical bytes, added claims, invalid routing and forged authority', () => {
  const template = serializeChecklistTemplate(items, true);
  expect(() => parseChecklistTemplate(template.trim())).toThrow();
  expect(() => parseChecklistTemplate(template.replace('"version": 1,', '"version": 0, "version": 1,'))).toThrow();
  const raw = JSON.parse(template);
  raw.questions[0].answer = 'invented';
  expect(() => parseChecklistTemplate(encode(raw))).toThrow();
  delete raw.questions[0].answer;
  raw.questions[0].scope = 'auto';
  expect(() => parseChecklistTemplate(encode(raw))).toThrow();
  raw.questions[0].scope = 'both';
  raw.authority_verified = true;
  expect(() => parseChecklistTemplate(encode(raw))).toThrow();
});
test('private report reconstructs source quotes, role-specific coverage, review statuses and exact snapshot hash', async () => {
  const text = await report();
  const raw = JSON.parse(text);
  expect(raw.snapshot_sha256).toBe(sha(snapshot));
  expect(raw.authority_verified).toBe(false);
  expect(raw.source_coverage).toEqual([
    { role: 'original', sha256: pins.original, physical_pages: 2, processed_pages: 1,
      indexed_fragments: 3, missing_pages: [], limited_pages: [1], limited: true },
    { role: 'revised', sha256: pins.revised, physical_pages: 1, processed_pages: 1,
      indexed_fragments: 2, missing_pages: [], limited_pages: [], limited: false },
  ]);
  expect(raw.summary).toEqual({ questions: 4, citations: 4, contextFragments: 2,
    matchedAllRoles: 1, partialOrContext: 1, noMatch: 1, unavailable: 1, reviewed: 1, needsFollowup: 1 });
  expect(raw.results[0].sources[0].citations[0]).toEqual({
    id: 'original:1:1', role: 'original', physical_page: 1, fragment_ordinal: 1,
    native_text: rows[0].text, kind: 'strict', context_group: null,
  });
  expect(raw.results[1].sources[0].citations.every((row: any) => row.kind === 'context' && row.context_group === 1)).toBe(true);
  expect(raw.results[3].sources[0].state).toBe('page_not_indexed');
  expect(text).not.toContain(rows[4].text);
  expect(text).toContain(reviews[0].note);
  const verified = await verifyChecklistReport(text, snapshot);
  expect(verified.items).toEqual(items);
  expect(verified.reviews).toEqual(reviews);
  expect(verified.results).toEqual(results);
  expect(verified.summary).toEqual(raw.summary);
  expect(await verifyAttachedChecklistReport(text, pins, corpora, index)).toEqual(verified);
  expect(await report()).toBe(text);
});
test('export rejects absent consent and stale or mismatched displayed retrieval results', async () => {
  await expect(serializeChecklistReport(index, pins, corpora, items, reviews, results, false)).rejects.toThrow();
  await expect(serializeChecklistReport(index, pins, corpora, items, reviews, results.slice(1), true)).rejects.toThrow();
  const forged = structuredClone(results);
  forged[0].sources[0].citations[0].source.text = 'Invented fee';
  await expect(serializeChecklistReport(index, pins, corpora, items, reviews, forged, true)).rejects.toThrow();
  await expect(serializeChecklistReport(buildIndex(rows.slice(0, 3)), pins, corpora, items, reviews, results, true)).rejects.toThrow();
  await expect(serializeChecklistReport(index, pins, corpora, items, reviews.slice(0, 1), results, true)).rejects.toThrow();
});
for (const [name, mutate] of [
  ['policy', (raw: any) => raw.policy = 'officially verified'],
  ['authority', (raw: any) => raw.authority_verified = true],
  ['snapshot hash', (raw: any) => raw.snapshot_sha256 = 'c'.repeat(64)],
  ['source fingerprint', (raw: any) => raw.source_coverage[0].sha256 = 'c'.repeat(64)],
  ['page coverage', (raw: any) => raw.source_coverage[0].processed_pages = 2],
  ['coverage flag', (raw: any) => raw.source_coverage[0].limited = false],
  ['role', (raw: any) => raw.results[0].sources[0].role = 'revised'],
  ['match status', (raw: any) => raw.results[2].state = 'matches_all_requested_roles'],
  ['source state', (raw: any) => raw.results[3].sources[0].state = 'matching_passages'],
  ['quote', (raw: any) => raw.results[0].sources[0].citations[0].native_text = 'Application fee: INR 999'],
  ['citation ID', (raw: any) => raw.results[0].sources[0].citations[0].id = 'original:1:2'],
  ['physical page', (raw: any) => raw.results[0].sources[0].citations[0].physical_page = 2],
  ['fragment ordinal', (raw: any) => raw.results[0].sources[0].citations[0].fragment_ordinal = 2],
  ['citation context', (raw: any) => raw.results[1].sources[0].citations[0].kind = 'strict'],
  ['context group', (raw: any) => raw.results[1].sources[0].citations[0].context_group = 9],
  ['match count', (raw: any) => raw.results[0].sources[0].matched_count = 100],
  ['truncation count', (raw: any) => raw.results[0].sources[0].omitted_strict_matches = 20],
  ['summary', (raw: any) => raw.summary.citations = 30],
  ['review status', (raw: any) => raw.reviews[0].status = 'verified'],
  ['duplicate review', (raw: any) => raw.reviews[1] = raw.reviews[0]],
  ['duplicate question', (raw: any) => raw.questions[1] = raw.questions[0]],
  ['changed routing', (raw: any) => raw.questions[0].scope = 'revised'],
  ['extra claim', (raw: any) => raw.results[0].answer = 'invented'],
  ['missing result', (raw: any) => raw.results.pop()],
] as const) {
  test('private checklist report rejects altered ' + name, async () => {
    const raw = JSON.parse(await report()); mutate(raw);
    await expect(verifyChecklistReport(encode(raw), snapshot)).rejects.toThrow();
  });
}
test('authored notes may change without becoming source claims, but canonical counts must remain consistent', async () => {
  const raw = JSON.parse(await report());
  raw.reviews[0].note = 'Revised personal opinion, not evidence.';
  const verified = await verifyChecklistReport(encode(raw), snapshot);
  expect(verified.reviews[0].note).toBe(raw.reviews[0].note);
  expect(verified.results).toEqual(results);
  raw.reviews[0].status = 'needs_followup';
  await expect(verifyChecklistReport(encode(raw), snapshot)).rejects.toThrow();
});
test('changed source bytes, extraction, layout or coverage cannot validate an old report', async () => {
  const text = await report();
  await expect(verifyChecklistReport(text, serializeCorpusSnapshot({ ...pins, original: 'c'.repeat(64) }, corpora))).rejects.toThrow();
  const changed = { ...corpora, original: { ...corpora.original, passages: [{ ...rows[0], text: 'Application fee: INR 900' }, ...rows.slice(1, 3)] } };
  await expect(verifyChecklistReport(text, serializeCorpusSnapshot(pins, changed))).rejects.toThrow();
  const geometry = { ...corpora, original: { ...corpora.original, passages: [{ ...rows[0],
    position: { x0: 1, x1: 50, y: 100, height: 10 } }, ...rows.slice(1, 3)] } };
  await expect(verifyChecklistReport(text, serializeCorpusSnapshot(pins, geometry))).rejects.toThrow();
  const coverage = { ...corpora, original: { ...corpora.original, limitedPages: [] } };
  await expect(verifyChecklistReport(text, serializeCorpusSnapshot(pins, coverage))).rejects.toThrow();
  await expect(verifyChecklistReport(text, snapshot.trim())).rejects.toThrow();
});
test('readers reject malformed UTF-8, empty or oversized files, and noncanonical duplicate members', async () => {
  const text = await report();
  await expect(verifyChecklistReport(text.trim(), snapshot)).rejects.toThrow();
  await expect(verifyChecklistReport(text.replace('"version": 1,', '"version": 0, "version": 1,'), snapshot)).rejects.toThrow();
  await expect(readChecklistFile(new File([], 'empty.json'), 'template')).rejects.toThrow();
  await expect(readChecklistFile(new File([new Uint8Array([0xff])], 'bad.json'), 'report')).rejects.toThrow();
  await expect(readChecklistFile(new File(['x'.repeat(MAX_CHECKLIST_TEMPLATE_BYTES + 1)], 'large.json'), 'template')).rejects.toThrow();
  await expect(readChecklistFile(new File(['x'.repeat(MAX_CHECKLIST_REPORT_BYTES + 1)], 'large.json'), 'report')).rejects.toThrow();
  expect(await readChecklistFile(new File([text], 'checklist.json'), 'report')).toBe(text);
  const template = serializeChecklistTemplate(items, true);
  expect(await readChecklistFile(new File([template], 'template.json'), 'template')).toBe(template);
});

test('print and spreadsheet derivatives contain all requested roles, coverage and explicit private warnings', async () => {
  const text = await report();
  const html = await prepareChecklistReadingCopy(text, snapshot, 'html');
  const csv = await prepareChecklistReadingCopy(text, snapshot, 'csv');
  expect(html.reportSha256).toBe(sha(text));
  expect(csv.reportSha256).toBe(html.reportSha256);
  expect(html.text).toContain('Content-Security-Policy');
  expect(html.text).toContain('No match does not prove absence');
  expect(html.text).toContain('Personal review (not evidence)');
  expect(html.text).toContain('Personal review &lt;b&gt;not evidence&lt;/b&gt;.');
  expect(html.text).not.toContain('<b>not evidence</b>');
  expect(html.text).not.toContain('<script');
  expect(html.text).not.toContain(rows[4].text);
  expect(html.text).toContain('Application fee: INR 500');
  expect(html.text).toContain('Application fee: INR 350');
  expect(html.text).toContain('page not indexed');
  expect(html.text).toContain(pins.original);
  expect(csv.text.charCodeAt(0)).toBe(0xfeff);
  expect(csv.text).toContain('"authority_verified"');
  expect(csv.text).toContain('"page_not_indexed"');
  expect(csv.text).toContain('"no_matching_passage"');
  expect(csv.text).toContain('"context"');
  expect(csv.text).not.toContain(rows[4].text);
  expect((await prepareChecklistReadingCopy(text, snapshot, 'html')).text).toBe(html.text);
});
test('CSV formula defense handles compatibility markers, whitespace, controls and quoted cells', () => {
  for (const input of ['=1+1', '+1', '-1', '@SUM(1)', ' \t=1', '\u200b=1', '＝1', '\tplain', '\rplain', '\nplain']) {
    expect(safeChecklistCsvCell(input)).toBe('"\'' + input + '"');
  }
  expect(safeChecklistCsvCell('ordinary, "text"')).toBe('"ordinary, ""text"""');
  expect(safeChecklistCsvCell('line one\nline two')).toBe('"line one\nline two"');
  expect(safeChecklistCsvCell(0)).toBe('"0"');
});
test('reading copy rejects forged excerpts or changed extraction rather than rendering imported text', async () => {
  const text = await report();
  const forged = text.replace('Application fee: INR 500', '<img src=x onerror=alert(1)>');
  await expect(prepareChecklistReadingCopy(forged, snapshot, 'html')).rejects.toThrow();
  await expect(prepareChecklistReadingCopy(forged, snapshot, 'csv')).rejects.toThrow();
  await expect(prepareChecklistReadingCopy(text, snapshot.replace(pins.original, 'c'.repeat(64)), 'html')).rejects.toThrow();
});
test('verified source excerpt and personal note are inert in HTML and spreadsheet copy', async () => {
  const passage: Passage = { role: 'original', page: 1, ordinal: 1, text: '= application fee <img src=x onerror=alert(1)>' };
  const sources = { original: { passages: [passage], pageCount: 1, processedPages: 1,
    missingPages: [], limitedPages: [], limited: false } satisfies Corpus };
  const selected = [{ id: 'fee', question: 'Application fee?', scope: 'original', includeContext: false }] satisfies ChecklistPlan;
  const search = buildIndex([passage]);
  const annotations = updateChecklistReview(selected, blankChecklistReviews(selected), 'fee', { note: '=HYPERLINK("x")' });
  const sourceSnapshot = serializeCorpusSnapshot({ original: pins.original }, sources);
  const generated = await serializeChecklistReport(search, { original: pins.original }, sources, selected, annotations,
    runChecklist(search, sources, selected), true);
  const html = (await prepareChecklistReadingCopy(generated, sourceSnapshot, 'html')).text;
  const csv = (await prepareChecklistReadingCopy(generated, sourceSnapshot, 'csv')).text;
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(html).not.toContain('<img');
  expect(html).toContain('=HYPERLINK(&quot;x&quot;)');
  expect(csv).toContain('"\'= application fee');
  expect(csv).toContain('"\'=HYPERLINK(""x"")"');
});

async function comparisonFixture(changedRows: Passage[], changedPins = pins, questions = items,
  annotations = blankChecklistReviews(questions)) {
  const sources = {
    original: { ...corpora.original, passages: changedRows.filter(row => row.role === 'original') },
    revised: { ...corpora.revised, passages: changedRows.filter(row => row.role === 'revised') },
  };
  const search = buildIndex(changedRows);
  const snap = serializeCorpusSnapshot(changedPins, sources);
  const result = await serializeChecklistReport(search, changedPins, sources, questions, annotations,
    runChecklist(search, sources, questions), true);
  return { snapshot: snap, report: result };
}
test('comparison of identical runs ignores personal review changes and question order', async () => {
  const left = { report: await report(), snapshot };
  const right = await comparisonFixture(rows, pins, [...items].reverse());
  const result = await compareChecklistRuns(left, right);
  expect(result.comparison.authority_verified).toBe(false);
  expect(result.comparison.summary).toMatchObject({ questions: 4, unchanged_questions: 4, changed_questions: 0 });
  expect(result.comparison.questions.map(row => row.question_id)).toEqual(items.map(row => row.id));
  expect(result.text).not.toContain(reviews[0].note);
  expect(result.text).not.toContain(rows[0].text);
  expect(result.text).not.toContain(items[0].question);
  expect(await replayChecklistComparison(result.text, left, right)).toEqual(result.comparison);
});
test('changed printed value and new PDF hash are classified as retrieval observations, not authority', async () => {
  const left = { report: await report(), snapshot };
  const changed = rows.map(row => row === rows[3] ? { ...row, text: 'Application fee: INR 250' } : row);
  const right = await comparisonFixture(changed, { ...pins, revised: 'c'.repeat(64) });
  const result = await compareChecklistRuns(left, right);
  const fee = result.comparison.questions.find(row => row.question_id === 'fee')!;
  expect(fee.sources[0].classification).toBe('unchanged_observation');
  expect(fee.sources[1]).toMatchObject({
    classification: 'coverage_or_source_changed', pdf_pin_changed: true, state_changed: false,
    strict_text: { identical_observations: 0, left_only_observations: 1, right_only_observations: 1 },
  });
  expect(result.text).not.toContain('INR 250');
  expect(result.comparison.sources[1].changed).toBe(true);
  expect(result.comparison.summary.changed_questions).toBe(2);
});
test('same PDF pin but changed native text is distinguishable from source pin changes', async () => {
  const left = { report: await report(), snapshot };
  const changed = rows.map(row => row === rows[0] ? { ...row, text: 'Application fee: INR 700' } : row);
  const right = await comparisonFixture(changed);
  const result = await compareChecklistRuns(left, right);
  const source = result.comparison.questions[0].sources[0];
  expect(source.classification).toBe('retrieval_observation_changed');
  expect(source.pdf_pin_changed).toBe(false);
  expect(source.strict_text.left_only_observations).toBe(1);
  expect(result.comparison.sources[0].changed).toBe(true);
});
test('moving a strict text fragment changes location counts without claiming a textual change', async () => {
  const left = { report: await report(), snapshot };
  const changed = rows.map(row => row === rows[3] ? { ...row, ordinal: 3 } :
    row === rows[4] ? { ...row, ordinal: 4 } : row);
  const right = await comparisonFixture(changed);
  const source = (await compareChecklistRuns(left, right)).comparison.questions[0].sources[1];
  expect(source.strict_text).toEqual({ identical_observations: 1, left_only_observations: 0, right_only_observations: 0 });
  expect(source.strict_locations).toEqual({ identical_observations: 0, left_only_observations: 1, right_only_observations: 1 });
  expect(source.classification).toBe('retrieval_observation_changed');
});
test('comparison rejects changed question routing, wording, missing rows, forged report or output', async () => {
  const left = { report: await report(), snapshot };
  for (const plan of [
    items.slice(1), items.map(row => row.id === 'fee' ? { ...row, question: 'Application fees?' } : row),
    items.map(row => row.id === 'fee' ? { ...row, scope: 'original' as const } : row),
    items.map(row => row.id === 'fee' ? { ...row, includeContext: true } : row),
  ]) {
    await expect(compareChecklistRuns(left, await comparisonFixture(rows, pins, plan))).rejects.toThrow();
  }
  await expect(compareChecklistRuns(left, { ...left, report: left.report.replace('INR 500', 'INR 999') })).rejects.toThrow();
  const result = await compareChecklistRuns(left, left);
  await expect(replayChecklistComparison(result.text.replace('"authority_verified": false', '"authority_verified": true'), left, left)).rejects.toThrow();
  await expect(replayChecklistComparison(result.text.trim(), left, left)).rejects.toThrow();
});

test('coarse coverage equality does not conceal changed extraction metadata', async () => {
  const left = { report: await report(), snapshot };
  const sources = {
    original: { ...corpora.original, pageCount: 3 },
    revised: corpora.revised,
  };
  const rightSnapshot = serializeCorpusSnapshot(pins, sources);
  const right = {
    snapshot: rightSnapshot,
    report: await serializeChecklistReport(index, pins, sources, items, reviews,
      runChecklist(index, sources, items), true),
  };
  const result = await compareChecklistRuns(left, right);
  const fee = result.comparison.questions.find(row => row.question_id === 'fee')!;
  expect(fee.sources[0]).toMatchObject({
    coverage_changed: false, source_coverage_metadata_changed: true,
    pdf_pin_changed: false, classification: 'coverage_or_source_changed',
  });
  const unavailable = result.comparison.questions.find(row => row.question_id === 'unavailable')!;
  expect(unavailable.sources[0].source_coverage_metadata_changed).toBe(false);
  expect(unavailable.changed).toBe(false);
  expect(result.comparison.sources[0]).toMatchObject({ left_physical_pages: 2, right_physical_pages: 3,
    left_missing_pages: [], right_missing_pages: [], left_limited_pages: [1], right_limited_pages: [1] });
});
test('unattached requested role is compared without silently substituting another source', async () => {
  const left = { report: await report(), snapshot };
  const sources = { original: corpora.original };
  const search = buildIndex(corpora.original.passages);
  const firstPin = { original: pins.original };
  const right = {
    snapshot: serializeCorpusSnapshot(firstPin, sources),
    report: await serializeChecklistReport(search, firstPin, sources, items, reviews,
      runChecklist(search, sources, items), true),
  };
  const compared = (await compareChecklistRuns(left, right)).comparison;
  const fee = compared.questions[0];
  expect(fee.left_state).toBe('matches_all_requested_roles');
  expect(fee.right_state).toBe('some_matches_or_context');
  expect(fee.sources[1]).toMatchObject({
    role: 'revised', pdf_pin_changed: true, coverage_changed: true,
    source_coverage_metadata_changed: true,
    right: { state: 'source_unattached', coverage: 'unattached', displayed_fragments: 0 },
    strict_text: { identical_observations: 0, left_only_observations: 1, right_only_observations: 0 },
  });
  expect(compared.sources[1]).toMatchObject({ right_pdf_sha256: null, right_missing_pages: null,
    right_limited_pages: null, right_indexed_fragments: null });
});
test('nearby-group comparison preserves group boundaries and does not turn context leads into strict matches', async () => {
  const left = { report: await report(), snapshot };
  const changed = rows.map(row => row === rows[2] ? { ...row, text: 'Residence certificate requested' } : row);
  const right = await comparisonFixture(changed);
  const source = (await compareChecklistRuns(left, right)).comparison.questions
    .find(row => row.question_id === 'context')!.sources[0];
  expect(source.left.state).toBe('context_leads');
  expect(source.right.state).toBe('context_leads');
  expect(source.strict_text).toEqual({ identical_observations: 0, left_only_observations: 0, right_only_observations: 0 });
  expect(source.context_text).toEqual({ identical_observations: 0, left_only_observations: 1, right_only_observations: 1 });
});

test('a physical-page query does not attribute a change on another physical page to its own scoped observations', async () => {
  const firstPage = { role: 'original', page: 1, ordinal: 1, text: 'Application fee: INR 500' } satisfies Passage;
  const secondPage = { role: 'original', page: 2, ordinal: 1, text: 'Administrative note' } satisfies Passage;
  const first: Corpus = { passages: [firstPage, secondPage], pageCount: 2, processedPages: 2,
    missingPages: [], limitedPages: [], limited: false };
  const second: Corpus = { ...first, passages: [firstPage, { ...secondPage, text: 'Different administrative note' }],
    limitedPages: [2], limited: true };
  const selected: ChecklistPlan = [
    { id: 'whole', question: 'Application fee?', scope: 'original', includeContext: false },
    { id: 'physical', question: 'Application fee on page 1?', scope: 'original', includeContext: false },
  ];
  const localPins = { original: pins.original };
  async function input(corpus: Corpus) {
    const sources = { original: corpus };
    const search = buildIndex(corpus.passages);
    return {
      snapshot: serializeCorpusSnapshot(localPins, sources),
      report: await serializeChecklistReport(search, localPins, sources, selected,
        blankChecklistReviews(selected), runChecklist(search, sources, selected), true),
    };
  }
  const result = (await compareChecklistRuns(await input(first), await input(second))).comparison;
  const whole = result.questions[0], physical = result.questions[1];
  expect(whole.changed).toBe(true);
  expect(whole.sources[0]).toMatchObject({
    classification: 'coverage_or_source_changed',
    source_coverage_metadata_changed: true,
    strict_text: { identical_observations: 1, left_only_observations: 0, right_only_observations: 0 },
  });
  expect(physical.changed).toBe(false);
  expect(physical.sources[0]).toMatchObject({
    classification: 'unchanged_observation',
    source_coverage_metadata_changed: false,
    coverage_changed: false,
  });
  expect(result.sources[0].changed).toBe(true);
  expect(result.summary.changed_questions).toBe(1);
});
test('a comparison cannot verify if the same two inputs are supplied in reverse order', async () => {
  const left = { report: await report(), snapshot };
  const right = await comparisonFixture(rows.map(row => row === rows[3] ?
    { ...row, text: 'Application fee: INR 300' } : row), { ...pins, revised: 'd'.repeat(64) });
  const forward = await compareChecklistRuns(left, right);
  const backward = await compareChecklistRuns(right, left);
  expect(forward.text).not.toBe(backward.text);
  expect(forward.comparison.left).toEqual(backward.comparison.right);
  expect(forward.comparison.right).toEqual(backward.comparison.left);
  await expect(replayChecklistComparison(forward.text, right, left)).rejects.toThrow();
  await expect(replayChecklistComparison(backward.text, left, right)).rejects.toThrow();
});
