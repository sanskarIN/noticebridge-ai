import { expect, test } from '@playwright/test';
import { buildIndex, type Corpus, type Passage, type Role } from '../src/pdfChatCore';
import { buildTimeline, compareTimeline, dateCoverage, describeTimelineValue, filterTimeline,
  inspectWindows, isoDate, parseTimelineValue, timelinePage, MAX_DATE_REVIEW_LEADS,
  type TimelineFilter } from '../src/pdfChatTimeline';

const row = (role: Role, page: number, ordinal: number, text: string): Passage => ({ role, page, ordinal, text });
const o = (page: number, ordinal: number, text: string) => row('original', page, ordinal, text);
const r = (page: number, ordinal: number, text: string) => row('revised', page, ordinal, text);
const rows = [
  o(1, 1, 'Application deadline: 20 December 2026'),
  o(1, 2, 'Application opening date: 2026-12-01'),
  o(1, 3, 'Examination date: 2027-01-05 to 2027-01-06'),
  o(2, 1, 'Payment deadline: 19 December 2026 at 17:30 IST'),
  o(2, 2, 'Result publication date: To be announced'),
  r(1, 1, 'Application deadline: 2026-12-15'),
  r(1, 2, 'Application opening date: 2026-12-01'),
  r(2, 1, 'Examination date: 2027-01-06'),
  r(2, 2, 'Examination date: 2027-01-08'),
];
function corpus(role: Role, passages: Passage[] = rows): Corpus {
  const matching = passages.filter(row => row.role === role);
  const count = Math.max(1, ...matching.map(row => row.page));
  return { passages: matching, pageCount: count, processedPages: count,
    missingPages: [], limitedPages: [], limited: false };
}
const timeline = buildTimeline(buildIndex(rows), { original: corpus('original'), revised: corpus('revised') });
const all: TimelineFilter = { scope: 'both', kind: 'all', parse: 'all', order: 'chronological' };

for (const [text, normalized] of [
  ['29 February 2028', '2028-02-29'],
  ['2026-12-01', '2026-12-01'],
  ['from 1 December 2026 to 20 December 2026', '2026-12-01 to 2026-12-20'],
  ['2026-12-01 through 2026-12-20', '2026-12-01 to 2026-12-20'],
  ['2026-12-01 – 2026-12-20', '2026-12-01 to 2026-12-20'],
  ['1 December 2026 at 5:30 PM IST', '2026-12-01 · printed clock text: 5:30 PM IST'],
  ['2026-12-01, 00:00 UTC', '2026-12-01 · printed clock text: 00:00 UTC'],
] as const) {
  test('literal date expression: ' + text, () => expect(describeTimelineValue(parseTimelineValue(text))).toBe(normalized));
}
for (const text of ['29 February 2027', '2026-02-31', '12/01/2026', 'December 2026', '2026',
  '1 Dec 2026', '2026-12-20 to 2026-12-01', '2026-12-01 to 20 December',
  '2026-12-01 at 25:00', '2026-12-01 at 13:00 PM', '2026-12-01 at 18:61',
  '2026-12-01 at 5 PM', '2026-12-01 at 10:00 PST',
  '2026-12-01 unless exempt', '2026-12-01 or 2026-12-20', 'Tomorrow', 'To be announced',
  '2026-12-01\n2026-12-02']) {
  test('unsupported or ambiguous date remains visible without parsing: ' + text, () => {
    expect(parseTimelineValue(text)).toEqual({ kind: 'unparsed' });
  });
}
test('timeline preserves every source occurrence including competing and unparsed dates', () => {
  expect(filterTimeline(timeline, all)).toHaveLength(rows.length);
  expect(filterTimeline(timeline, { ...all, order: 'source' }).map(row => row.occurrence.field.source)).toEqual(rows);
  const first = filterTimeline(timeline, all)[0].occurrence.parsed;
  expect(first.kind === 'single' && isoDate(first.date)).toBe('2026-12-01');
  expect(filterTimeline(timeline, all).at(-1)?.occurrence.field.source).toBe(rows[4]);
});
test('scope, kind, physical page and parse filters apply independently', () => {
  expect(filterTimeline(timeline, { ...all, scope: 'original', page: 2, kind: 'closing' })
    .map(row => row.occurrence.field.source)).toEqual([rows[3]]);
  expect(filterTimeline(timeline, { ...all, parse: 'unparsed' }).map(row => row.occurrence.field.source)).toEqual([rows[4]]);
  expect(filterTimeline(timeline, { ...all, scope: 'revised', kind: 'event' })).toHaveLength(2);
});
test('same field comparisons are signed and ignore date representation differences', () => {
  const pairs = compareTimeline(timeline);
  expect(pairs.find(pair => pair.field.id === 'application_deadline')).toMatchObject({
    outcome: 'different_day', deltaDays: -5,
  });
  expect(pairs.find(pair => pair.field.id === 'application_start')).toMatchObject({
    outcome: 'same_day', deltaDays: 0,
  });
  expect(pairs.find(pair => pair.field.id === 'exam_date')).toMatchObject({
    outcome: 'review_required', deltaDays: null,
  });
  expect(pairs.find(pair => pair.field.id === 'payment_deadline')).toMatchObject({ outcome: 'missing_label' });
});
test('window arithmetic stays within one source and reports literal subtraction', () => {
  expect(inspectWindows(timeline).map(window => [window.role, window.outcome, window.differenceDays])).toEqual([
    ['original', 'printed_order', 19], ['revised', 'printed_order', 14],
  ]);
  const reverse = [o(1, 1, 'Application opening date: 2026-12-20'), o(1, 2, 'Application deadline: 2026-12-01')];
  const result = inspectWindows(buildTimeline(buildIndex(reverse), { original: corpus('original', reverse) }));
  expect(result[0]).toMatchObject({ outcome: 'reversed_printed_order', differenceDays: -19 });
});
test('duplicates retain all physical evidence without silently choosing a different printed value', () => {
  const repeated = [o(1, 1, 'Application deadline: 2026-12-20'),
    o(1, 2, 'Application deadline: 2026-12-20'), o(2, 1, 'Application deadline: 20 December 2026')];
  const result = buildTimeline(buildIndex(repeated), { original: corpus('original', repeated) });
  expect(result.events[0].occurrences).toHaveLength(3);
  expect(result.events[0].distinctPrintedValues).toBe(2);
  expect(result.events[0].reason).toBe('multiple_values');
  expect(result.events[0].comparableDate).toBeNull();
});
test('unlabeled possible conditions withhold arithmetic; unrelated other-role text does not', () => {
  const source = [o(1, 1, 'Application deadline: 2026-12-20'),
    o(2, 1, 'The application deadline differs for exempt applicants.'),
    r(1, 1, 'Application deadline: 2026-12-15')];
  const result = buildTimeline(buildIndex(source), { original: corpus('original', source), revised: corpus('revised', source) });
  expect(result.events.find(event => event.role === 'original')?.reason).toBe('possible_conditions');
  expect(result.events.find(event => event.role === 'revised')?.reason).toBe('unique');
  expect(compareTimeline(result)[0].outcome).toBe('review_required');
});
test('review leads remain bounded but all matches contribute to withholding', () => {
  const source = [o(1, 1, 'Application deadline: 2026-12-20'),
    ...Array.from({ length: 20 }, (_, i) => o(1, i + 2, 'Application deadline may differ for group ' + i))];
  const result = buildTimeline(buildIndex(source), { original: corpus('original', source) });
  const first = result.events[0].occurrences[0];
  expect(first.reviewLeadCount).toBe(20);
  expect(first.reviewLeads).toHaveLength(MAX_DATE_REVIEW_LEADS);
  expect(result.events[0].comparableDate).toBeNull();
});
test('no missing-source substitution and no automatic timeline for image-only PDFs', () => {
  const source = [o(1, 1, 'Application deadline: 2026-12-20')];
  const result = buildTimeline(buildIndex(source), { original: corpus('original', source) });
  expect(compareTimeline(result)[0].outcome).toBe('missing_source');
  expect(inspectWindows(result)[0].outcome).toBe('missing_label');
  expect(buildTimeline(buildIndex([]), { original: { ...corpus('original', []), missingPages: [1] } }).events).toEqual([]);
});
test('coverage retains exact physical page distinctions', () => {
  const doc: Corpus = { passages: [], pageCount: 4, processedPages: 3, missingPages: [2], limitedPages: [3], limited: true };
  expect(dateCoverage(doc, 1)).toContain('Some native text');
  expect(dateCoverage(doc, 2)).toContain('no indexed native text');
  expect(dateCoverage(doc, 3)).toContain('partially');
  expect(dateCoverage(doc, 4)).toContain('not indexed');
  expect(dateCoverage(doc, 5)).toContain('does not exist');
  expect(dateCoverage(undefined)).toContain('not attached');
});
test('pagination and source identity checks fail closed', () => {
  expect(() => filterTimeline(timeline, { ...all, page: 81 })).toThrow();
  expect(() => timelinePage([], 2)).toThrow();
  expect(timelinePage([], 1)).toEqual({ pages: 1, rows: [] });
  expect(() => buildTimeline(buildIndex([rows[0], rows[0]]), { original: corpus('original') })).toThrow();
  expect(() => buildTimeline(buildIndex([rows[5]]), { original: corpus('original') })).toThrow();
});
