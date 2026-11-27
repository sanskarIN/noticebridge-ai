import { expect, test } from '@playwright/test';
import { buildIndex, type Corpus, type Passage, type Scope } from '../src/pdfChatCore';
import { addChecklistPreset, appendChecklist, blankChecklistReviews, carryChecklistReviews, checklistCounts,
  checklistItem, checklistPage, checklistPresets, checklistReviewCounts, filterChecklist, moveChecklistItem,
  nextChecklistId, removeChecklistItem, replaceChecklistItem, runChecklist, updateChecklistReview,
  validateChecklist, validateChecklistReviews, MAX_CHECKLIST_ITEMS, MAX_CHECKLIST_NOTE,
  type ChecklistItem, type ChecklistPlan } from '../src/pdfChatChecklist';
import type { ChatCorpora } from '../src/pdfChatEvidenceReport';

const original: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Application fee: INR 500' },
  { role: 'original', page: 1, ordinal: 2, text: 'Application deadline: 19 December 2026' },
  { role: 'original', page: 1, ordinal: 3, text: 'Rural applicants' },
  { role: 'original', page: 1, ordinal: 4, text: 'Residence certificate required' },
  { role: 'original', page: 2, ordinal: 1, text: 'Examination date: 2026-12-15' },
];
const revised: Passage[] = [
  { role: 'revised', page: 1, ordinal: 1, text: 'Application fee: INR 350' },
  { role: 'revised', page: 1, ordinal: 2, text: 'Eligibility: Class 12 or equivalent' },
  { role: 'revised', page: 2, ordinal: 1, text: 'Examination date: 2026-12-16' },
];
function corpus(passages: Passage[], patch: Partial<Corpus> = {}): Corpus {
  return { passages, pageCount: 2, processedPages: 2,
    missingPages: [], limitedPages: [], limited: false, ...patch };
}
const corpora: ChatCorpora = { original: corpus(original), revised: corpus(revised) };
const index = buildIndex([...original, ...revised]);
function question(id: string, text: string, scope: Scope = 'both', includeContext = false): ChecklistItem {
  return { id, question: text, scope, includeContext };
}
const base: ChecklistPlan = [
  question('fee', 'Application fee?'),
  question('deadline', 'Application deadline?'),
  question('refund', 'Refund policy?'),
  question('date', 'Examination date on page 2?'),
  question('context', 'Rural residence certificate?', 'original', true),
  question('missing', 'Application fee on page 3?', 'revised'),
];
function run(items = base, sources = corpora, rows = index) { return runChecklist(rows, sources, items); }

test('independent checklist queries keep source roles, page routes, abstention and context separate', () => {
  const rows = run();
  expect(rows.map(row => row.item.id)).toEqual(base.map(row => row.id));
  expect(rows.map(row => row.state)).toEqual([
    'matches_all_requested_roles', 'some_matches_or_context', 'no_matching_passages',
    'matches_all_requested_roles', 'some_matches_or_context', 'unavailable',
  ]);
  expect(rows[0].sources.map(source => source.citations.map(citation => citation.source.text)))
    .toEqual([['Application fee: INR 500'], ['Application fee: INR 350']]);
  expect(rows[0].sources.every(source => source.state === 'matching_passages')).toBe(true);
  expect(rows[1].sources.map(source => source.state)).toEqual(['matching_passages', 'no_matching_passage']);
  expect(rows[2].sources.every(source => source.citations.length === 0)).toBe(true);
  expect(rows[3].physicalPage).toBe(2);
  expect(rows[3].sources.every(source => source.citations.every(citation => citation.source.page === 2))).toBe(true);
  expect(rows[4].sources[0].state).toBe('context_leads');
  expect(rows[4].sources[0].matchedCount).toBe(0);
  expect(rows[4].sources[0].omittedStrictMatches).toBe(0);
  expect(rows[4].sources[0].citations.map(citation => [citation.kind, citation.contextGroup, citation.source.text]))
    .toEqual([['context', 1, 'Rural applicants'], ['context', 1, 'Residence certificate required']]);
  expect(rows[5].sources[0]).toMatchObject({ role: 'revised', coverage: 'not_present',
    state: 'page_not_present', matchedCount: 0, displayedCount: 0, citations: [] });
  expect(checklistCounts(rows)).toEqual({ matches_all_requested_roles: 2,
    some_matches_or_context: 2, no_matching_passages: 1, unavailable: 1 });
});
test('nearby fallback never changes strict matches and can be disabled per row', () => {
  const strict = question('strict', 'Rural residence certificate?', 'original');
  const nearby = question('nearby', 'Rural residence certificate?', 'original', true);
  const rows = run([strict, nearby, question('fee-strict', 'Application fee?', 'original'),
    question('fee-context', 'Application fee?', 'original', true)]);
  expect(rows[0].state).toBe('no_matching_passages');
  expect(rows[1].state).toBe('some_matches_or_context');
  expect(rows[2].sources[0].citations).toEqual(rows[3].sources[0].citations);
  expect(rows[3].sources[0].citations.every(row => row.kind === 'strict' && row.contextGroup === null)).toBe(true);
});
test('one attached source does not substitute for a missing requested version', () => {
  const sources = { original: corpora.original! }, rows = buildIndex(original);
  const results = run([question('both', 'Application fee?'), question('second', 'Application fee?', 'revised'),
    question('first', 'Application fee?', 'original')], sources, rows);
  expect(results[0].state).toBe('some_matches_or_context');
  expect(results[0].sources[1]).toMatchObject({ role: 'revised', coverage: 'unattached',
    state: 'source_unattached', citations: [] });
  expect(results[1].state).toBe('unavailable');
  expect(results[1].sources).toHaveLength(1);
  expect(results[1].sources[0].role).toBe('revised');
  expect(results[2].state).toBe('matches_all_requested_roles');
});
test('revised-only PDF retains its actual role and cannot become original', () => {
  const sources = { revised: corpora.revised! };
  const results = run([question('fee', 'Application fee?'), question('first', 'Application fee?', 'original')],
    sources, buildIndex(revised));
  expect(results[0].sources.map(row => row.state)).toEqual(['source_unattached', 'matching_passages']);
  expect(results[0].sources[1].citations[0].source.role).toBe('revised');
  expect(results[1].state).toBe('unavailable');
});
test('physical page coverage distinguishes absent pages, indexing limits and empty native pages', () => {
  const first = original.filter(row => row.page === 1);
  const sources = { original: corpus(first, { pageCount: 4, processedPages: 2,
    missingPages: [2], limitedPages: [1], limited: true }) };
  const items = [1, 2, 3, 5].map(page => question('page-' + page, 'Application fee on page ' + page + '?', 'original'));
  const results = run(items, sources, buildIndex(first));
  expect(results.map(row => row.sources[0].coverage)).toEqual(['limited', 'no_indexed_text', 'not_indexed', 'not_present']);
  expect(results.map(row => row.sources[0].state)).toEqual(['matching_passages', 'no_indexed_text', 'page_not_indexed', 'page_not_present']);
  expect(results[0].state).toBe('matches_all_requested_roles');
  expect(results.slice(1).every(row => row.state === 'unavailable')).toBe(true);
  const whole = run([question('whole', 'Application fee?', 'original')], sources, buildIndex(first))[0];
  expect(whole.sources[0].coverage).toBe('limited');
});
test('image-only and limited blank pages never report a successful or negative answer', () => {
  const blank = corpus([], { missingPages: [1, 2] });
  const limited = corpus([], { missingPages: [1, 2], limitedPages: [1], limited: true });
  const sources = { original: blank, revised: limited };
  const results = run([question('fee', 'Application fee?'), question('page', 'Application fee on page 1?')],
    sources, buildIndex([]));
  expect(results.every(row => row.state === 'unavailable')).toBe(true);
  expect(results[0].sources.map(source => source.coverage)).toEqual(['no_indexed_text', 'limited']);
  expect(results[0].sources.every(source => source.state === 'no_indexed_text')).toBe(true);
});
test('matching counts disclose strict citation truncation, preserving distinct physical identities', () => {
  const passages: Passage[] = Array.from({ length: 8 }, (_, i) => ({
    role: 'original', page: i < 4 ? 1 : 2, ordinal: i % 4 + 1, text: 'Application fee: INR ' + (100 + i),
  }));
  const row = run([question('fees', 'Application fee?', 'original')], { original: corpus(passages) },
    buildIndex(passages))[0].sources[0];
  expect(row.matchedCount).toBe(8);
  expect(row.displayedCount).toBe(4);
  expect(row.omittedStrictMatches).toBe(4);
  expect(row.citations.every(citation => citation.kind === 'strict')).toBe(true);
});
test('same printed text on separate pages retains distinct physical citations', () => {
  const passages: Passage[] = [1, 2].map(page => ({
    role: 'original', page, ordinal: 1, text: 'Application fee: INR 500',
  }));
  const row = run([question('fee', 'Application fee?', 'original')], { original: corpus(passages) },
    buildIndex(passages))[0].sources[0];
  expect(row.citations.map(item => item.source.page)).toEqual([1, 2]);
  expect(row.matchedCount).toBe(2);
});
test('checklist index and coverage corpus must describe the same exact fragments', () => {
  expect(() => run(base, corpora, buildIndex(original))).toThrow();
  expect(() => run(base, corpora, buildIndex([...original, ...revised.map((row, i) =>
    i === 0 ? { ...row, text: 'Application fee: INR 900' } : row)]))).toThrow();
  expect(() => run(base, { original: corpus([...original, original[0]]) },
    buildIndex([...original, original[0]]))).toThrow();
  const forged = [{ ...original[0], position: { x0: 10, x1: 30, y: 100, height: 10 } }, ...original.slice(1)];
  expect(() => run([question('fee', 'Application fee?', 'original')], { original: corpus(original) },
    buildIndex(forged))).toThrow();
  expect(() => run(base, {}, buildIndex([]))).toThrow();
});
test('all presets use recognized printed fields and are reusable across explicit scopes', () => {
  const ids = new Set<string>();
  for (const preset of checklistPresets) {
    expect(ids.has(preset.id)).toBe(false);
    ids.add(preset.id);
    for (const scope of ['original', 'revised', 'both'] as Scope[]) {
      const result = addChecklistPreset([], preset.id, scope, false);
      expect(result.added).toBe(preset.fields.length);
      expect(result.skipped).toBe(0);
      expect(result.items.every(row => row.scope === scope && !row.includeContext)).toBe(true);
      expect(run(result.items)).toHaveLength(result.added);
      const again = addChecklistPreset(result.items, preset.id, scope, false);
      expect(again.added).toBe(0);
      expect(again.skipped).toBe(preset.fields.length);
      expect(again.items).toEqual(result.items);
    }
  }
});
test('duplicate queries are rejected by normalized wording but separate scopes and context policies are allowed', () => {
  const fee = question('a', 'Application fee?', 'original');
  expect(() => validateChecklist([fee, question('b', 'APPLICATION FEE', 'original')])).toThrow();
  expect(validateChecklist([fee, question('b', 'Application fee?', 'revised'),
    question('c', 'Application fee?', 'original', true),
    question('d', 'Application fee on page 2?', 'original')])).toHaveLength(4);
});
for (const [name, mutate] of [
  ['invalid identifier', (row: any) => row.id = '../bad'],
  ['blank question', (row: any) => row.question = ''],
  ['untrimmed question', (row: any) => row.question = ' Application fee?'],
  ['oversized question', (row: any) => row.question = 'a'.repeat(401)],
  ['multiple questions', (row: any) => row.question = 'Application fee? Deadline?'],
  ['compound fields', (row: any) => row.question = 'What is the application deadline and fee?'],
  ['multiple pages', (row: any) => row.question = 'Application fee on page 1 and 2?'],
  ['invalid page', (row: any) => row.question = 'Application fee on page 81?'],
  ['page range', (row: any) => row.question = 'Application fee on pages 1-2?'],
  ['routing only', (row: any) => row.question = 'On page 2?'],
  ['source conflict', (row: any) => { row.scope = 'original'; row.question = 'Application fee in the revised notice?'; }],
  ['auto scope', (row: any) => row.scope = 'auto'],
  ['unknown scope', (row: any) => row.scope = 'latest'],
  ['context string', (row: any) => row.includeContext = 'false'],
  ['embedded newline', (row: any) => row.question = 'Application\nfee?'],
  ['control character', (row: any) => row.question = 'Application' + String.fromCharCode(0) + 'fee?'],
  ['isolated surrogate', (row: any) => row.question = 'Application fee ' + String.fromCharCode(0xd800)],
  ['unexpected answer', (row: any) => row.answer = 'invented'],
] as const) {
  test('checklist item rejects ' + name, () => {
    const row = question('fee', 'Application fee?'); mutate(row);
    expect(() => checklistItem(row)).toThrow();
  });
}
test('item budget and preset additions are all-or-nothing', () => {
  const rows = Array.from({ length: MAX_CHECKLIST_ITEMS }, (_, i) =>
    question('question-' + (i + 1), 'Policy code ' + i + '?', 'original'));
  expect(validateChecklist(rows)).toHaveLength(MAX_CHECKLIST_ITEMS);
  expect(() => appendChecklist(rows, question('overflow', 'Another question?', 'original'))).toThrow();
  const nearly = rows.slice(0, MAX_CHECKLIST_ITEMS - 1);
  const previous = JSON.stringify(nearly);
  expect(() => addChecklistPreset(nearly, 'quick', 'original', false)).toThrow();
  expect(JSON.stringify(nearly)).toBe(previous);
  expect(() => addChecklistPreset([], 'missing', 'original', false)).toThrow();
  expect(() => validateChecklist([rows[0], { ...rows[0], question: 'Different question?' }])).toThrow();
  expect(() => validateChecklist([])).toThrow();
  expect(validateChecklist([], true)).toEqual([]);
});
test('editing, movement and removal preserve plan identity without mutating inputs', () => {
  const items = [question('question-1', 'Application fee?'), question('question-2', 'Examination date?')];
  expect(nextChecklistId(items)).toBe('question-3');
  const moved = moveChecklistItem(items, 'question-2', -1);
  expect(moved.map(row => row.id)).toEqual(['question-2', 'question-1']);
  const edited = replaceChecklistItem(moved, 'question-1', { ...items[0], question: 'Registration fee?' });
  expect(edited[1].question).toBe('Registration fee?');
  expect(removeChecklistItem(edited, 'question-2')).toEqual([edited[1]]);
  expect(removeChecklistItem([items[0]], 'question-1')).toEqual([]);
  expect(items.map(row => row.question)).toEqual(['Application fee?', 'Examination date?']);
  expect(() => moveChecklistItem(items, 'question-1', -1)).toThrow();
  expect(() => moveChecklistItem(items, 'question-2', 1)).toThrow();
  expect(() => removeChecklistItem(items, 'absent')).toThrow();
  expect(() => replaceChecklistItem(items, 'question-1', { ...items[0], id: 'changed' })).toThrow();
});
test('personal review notes are separate from retrieval and clear when a question or route changes', () => {
  const items = [question('fee', 'Application fee?'), question('date', 'Examination date?')];
  let reviews = blankChecklistReviews(items);
  reviews = updateChecklistReview(items, reviews, 'fee', { status: 'reviewed_manually', note: 'Read the actual first page.' });
  reviews = updateChecklistReview(items, reviews, 'date', { status: 'needs_followup', note: 'Check latest official publication.' });
  expect(checklistReviewCounts(reviews)).toEqual({ unreviewed: 0, reviewed_manually: 1, needs_followup: 1 });
  const reordered = moveChecklistItem(items, 'date', -1);
  expect(carryChecklistReviews(items, reviews, reordered)).toEqual([reviews[1], reviews[0]]);
  const edited = replaceChecklistItem(reordered, 'date', { ...reordered[0], scope: 'original' });
  expect(carryChecklistReviews(items, reviews, edited)).toEqual([{ id: 'date', status: 'unreviewed', note: '' }, reviews[0]]);
  const removed = removeChecklistItem(items, 'fee');
  expect(carryChecklistReviews(items, reviews, removed)).toEqual([reviews[1]]);
  expect(run(items)).toEqual(run(items)); // authored review never enters retrieval input
});
test('review schema rejects unknown or duplicated identities, forged status and invalid notes', () => {
  const items = [base[0], base[1]], reviews = blankChecklistReviews(items);
  expect(() => validateChecklistReviews([reviews[0]], items)).toThrow();
  expect(() => validateChecklistReviews([reviews[0], reviews[0]], items)).toThrow();
  expect(() => validateChecklistReviews([{ ...reviews[0], id: 'unknown' }, reviews[1]], items)).toThrow();
  expect(() => updateChecklistReview(items, reviews, 'fee', { status: 'officially_verified' as any })).toThrow();
  expect(() => updateChecklistReview(items, reviews, 'fee', { note: 'x'.repeat(MAX_CHECKLIST_NOTE + 1) })).toThrow();
  expect(() => updateChecklistReview(items, reviews, 'fee', { note: ' note ' })).toThrow();
  expect(() => updateChecklistReview(items, reviews, 'fee', { note: String.fromCharCode(0xd800) })).toThrow();
  expect(() => updateChecklistReview(items, reviews, 'fee', { answer: 'invented' } as any)).toThrow();
  expect(() => updateChecklistReview(items, reviews, 'unknown', { note: 'note' })).toThrow();
});
test('result filters and pagination never rewrite original result counts or identities', () => {
  const results = run();
  const reviews = updateChecklistReview(base, blankChecklistReviews(base), 'deadline', { status: 'needs_followup' });
  const filtered = filterChecklist(results, reviews, { state: 'some_matches_or_context', review: 'needs_followup', keyword: 'DEADLINE' });
  expect(filtered.map(row => row.item.id)).toEqual(['deadline']);
  expect(checklistCounts(results).some_matches_or_context).toBe(2);
  const large = [...results, ...results.map(row => ({ ...row, item: { ...row.item, id: row.item.id + '-next' } }))];
  expect(checklistPage(large, 1)).toMatchObject({ page: 1, pages: 2, total: 12 });
  expect(checklistPage(large, 99).rows.map(row => row.item.id)).toEqual(results.map(row => row.item.id + '-next'));
  expect(checklistPage([], 8)).toEqual({ page: 1, pages: 1, total: 0, rows: [] });
  expect(() => checklistPage(results, 0)).toThrow();
});
