import { expect, test } from '@playwright/test';
import { buildIndex, type Corpus, type Passage, type Role } from '../src/pdfChatCore';
import { answerScopedQuestions } from '../src/pdfChatInsights';
import { answerCategoryTable, buildCategoryTables, tableCellQuestion, tableQuestion } from '../src/pdfChatTables';

type Cell = { text: string; x: number; y: number; width?: number };
function corpus(cells: Cell[], role: Role = 'original', page = 1): Corpus {
  return {
    passages: cells.map((cell, i) => ({
      role, page, ordinal: i + 1, text: cell.text,
      position: { x0: cell.x, x1: cell.x + (cell.width ?? cell.text.length * 5), y: cell.y, height: 12 },
    })),
    missingPages: [], limited: false, pageCount: page, processedPages: page, limitedPages: [],
  };
}
const fixture: Cell[] = [
  { text: 'Category', x: 40, y: 700 },
  { text: 'Application fee', x: 200, y: 700 },
  { text: 'Examination fee', x: 390, y: 700 },
  { text: 'General', x: 40, y: 670 },
  { text: 'Rs. 500', x: 200, y: 670 },
  { text: 'Rs. 800', x: 390, y: 670 },
  { text: 'Reserved', x: 40, y: 640 },
  { text: 'Rs. 250', x: 200, y: 640 },
  { text: 'Rs. 400', x: 390, y: 640 },
];
function ask(question: string, documents: Corpus[] = [corpus(fixture)], scope: 'original' | 'revised' | 'both' = 'original') {
  const passages = documents.flatMap(document => document.passages);
  const roles = [...new Set(passages.map(passage => passage.role))];
  const answer = answerScopedQuestions(buildIndex(passages), question, scope, roles)[0];
  return answerCategoryTable(documents.flatMap(document => buildCategoryTables(document).tables), answer);
}

test('associates a complete category row and field header without combining source text', () => {
  const document = corpus(fixture);
  const result = ask('What is the application fee for Reserved category?', [document]);
  expect(result?.matches).toHaveLength(1);
  const match = result?.matches[0];
  expect(match?.categoryHeader).toBe(document.passages[0]);
  expect(match?.fieldHeader).toBe(document.passages[1]);
  expect(match?.category).toBe(document.passages[6]);
  expect(match?.value).toBe(document.passages[7]);
});
test('distinguishes adjacent fee columns', () => {
  expect(ask('Examination fee for General')?.matches[0].value.text).toBe('Rs. 800');
  expect(ask('Application fee for General')?.matches[0].value.text).toBe('Rs. 500');
});
test('layout association does not rely on PDF extraction order', () => {
  const document = corpus(fixture);
  document.passages.reverse();
  expect(ask('Application fee for Reserved', [document])?.matches[0].value.text).toBe('Rs. 250');
});
test('both versions remain separate and physical page filters are enforced', () => {
  const original = corpus(fixture);
  const revised = corpus(fixture.map(cell => cell.text === 'Rs. 500' ? { ...cell, text: 'Rs. 350' } : cell), 'revised', 2);
  expect(ask('Application fee for General', [original, revised], 'both')?.matches.map(m => [m.role, m.value.text]))
    .toEqual([['original', 'Rs. 500'], ['revised', 'Rs. 350']]);
  const page = ask('Application fee for General on page 2', [original, revised], 'both');
  expect(page?.matches.map(m => m.role)).toEqual(['revised']);
  expect(page?.missingRoles).toEqual(['original']);
});
test('unknown categories, partial category names and extra qualifiers are not guessed', () => {
  for (const question of [
    'Application fee for Gen', 'Application fee for General and Reserved',
    'Application fee for General without registration', 'Application fee for Missing',
    'Refundable application fee for General', 'Application fee', 'Application fee for not General',
  ]) expect(ask(question)).toBeNull();
});
test('multiple separate source tables retain conflicting values without selecting one', () => {
  const docs = [corpus(fixture), corpus(fixture.map(c => c.text === 'Rs. 500' ? { ...c, text: 'Rs. 999' } : c), 'original', 2)];
  expect(ask('Application fee for General', docs)?.matches.map(m => m.value.text)).toEqual(['Rs. 500', 'Rs. 999']);
});
for (const [name, cells] of [
  ['missing cell', fixture.filter((_, i) => i !== 7)],
  ['extra cell', [...fixture, { text: 'Unrelated', x: 520, y: 640 }]],
  ['duplicate category', fixture.map(c => c.text === 'Reserved' ? { ...c, text: 'General category' } : c)],
  ['unknown heading', fixture.map(c => c.text === 'Application fee' ? { ...c, text: 'Amount' } : c)],
  ['duplicate field', fixture.map(c => c.text === 'Examination fee' ? { ...c, text: 'Application charges' } : c)],
  ['misaligned cell', fixture.map(c => c.text === 'Rs. 250' ? { ...c, x: 220 } : c)],
  ['overlapping header', fixture.map(c => c.text === 'Application fee' ? { ...c, width: 200 } : c)],
  ['irregular baseline', fixture.map(c => c.y === 640 ? { ...c, y: 650 } : c)],
  ['only one row', fixture.slice(0, 6)],
  ['wrapped continuation', [...fixture, { text: 'Subject to conditions', x: 200, y: 626 }]],
] as [string, Cell[]][]) {
  test('rejects ambiguous layout: ' + name, () => {
    expect(buildCategoryTables(corpus(cells)).tables).toEqual([]);
  });
}
test('partial and unsupported page geometry cannot establish a table', () => {
  const document = corpus(fixture);
  document.limitedPages = [1];
  expect(buildCategoryTables(document)).toEqual({ tables: [], skippedPages: [1], limited: false });
  document.limitedPages = [];
  delete document.passages[4].position;
  expect(buildCategoryTables(document).tables).toEqual([]);
});
test('page and source boundary cannot be crossed to complete an incomplete row', () => {
  const document = corpus(fixture);
  document.passages[7].page = 2;
  expect(buildCategoryTables(document).tables).toEqual([]);
  document.passages[7].page = 1;
  document.passages[7].role = 'revised';
  expect(buildCategoryTables(document).tables).toEqual([]);
});
test('page fragment cap is explicit', () => {
  const document = corpus(fixture);
  const extra: Passage[] = Array.from({ length: 513 }, (_, i) => ({
    role: 'original', page: 1, ordinal: 100 + i, text: 'extra',
    position: { x0: 10, x1: 30, y: 300 - i, height: 12 },
  }));
  document.passages.push(...extra);
  expect(buildCategoryTables(document).skippedPages).toEqual([1]);
});
test('explicit page directive and category grammar remain visible', () => {
  const doc = corpus(fixture);
  const answer = answerScopedQuestions(buildIndex(doc.passages), 'Application fee for Reserved category on page 1?', 'original', ['original'])[0];
  expect(tableQuestion(answer)).toEqual({ field: 'application_fee', category: 'reserved' });
});


test('source phrases do not contaminate the exact category', () => {
  expect(ask('Application fee for General category in the original notice?')?.matches[0].value.text).toBe('Rs. 500');
});
test('guided questions round-trip exact field and page', () => {
  const table = buildCategoryTables(corpus(fixture, 'original', 2)).tables[0];
  expect(tableCellQuestion(table, 1, 1)).toBe('Application fee for Reserved on page 2?');
  expect(tableCellQuestion(table, 1, 2)).toBe('Examination fee for Reserved on page 2?');
  expect(tableCellQuestion(table, 0, 0)).toBeNull();
  expect(tableCellQuestion(table, 99, 1)).toBeNull();
});
test('guidance is disabled rather than throwing for routing-like printed labels', () => {
  const odd = corpus(fixture.map(cell => cell.text === 'Reserved' ? { ...cell, text: 'Reserved on page 2' } : cell));
  const table = buildCategoryTables(odd).tables[0];
  expect(tableCellQuestion(table, 1, 1)).toBeNull();
});
