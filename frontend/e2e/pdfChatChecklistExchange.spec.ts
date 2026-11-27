import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
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
