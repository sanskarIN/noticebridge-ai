import { expect, test } from '@playwright/test';
import { NativePageAssembler, MAX_NATIVE_DOCUMENT_CHARS, MAX_NATIVE_DOCUMENT_PASSAGES,
  MAX_NATIVE_PAGE_ITEMS, type NativeTextItem, type PageBudget } from '../src/pdfChatNativeText';
import { answerQuestion, buildIndex } from '../src/pdfChatCore';

function item(str: string, x = 10, y = 200, width = 40, hasEOL = false): NativeTextItem {
  return { str, transform: [10, 0, 0, 10, x, y], width, height: 10, hasEOL };
}
function page(items: unknown[], overrides: Partial<PageBudget> = {}, complete = true) {
  const assembler = new NativePageAssembler('original', 1, {
    chars: MAX_NATIVE_DOCUMENT_CHARS, passages: MAX_NATIVE_DOCUMENT_PASSAGES,
    items: MAX_NATIVE_PAGE_ITEMS, ...overrides,
  });
  for (const entry of items) if (!assembler.push(entry)) break;
  return assembler.finish(complete);
}
test('assembles normal fragments without changing literal text or valid geometry', () => {
  const result = page([item('Application', 10, 200, 50),
    item('fee:', 64, 200, 18), item('Rs. 500', 86, 200, 35, true)]);
  expect(result.passages).toEqual([{ role: 'original', page: 1, ordinal: 1,
    text: 'Application fee: Rs. 500', position: { x0: 10, x1: 121, y: 200, height: 10 } }]);
  expect(result.chars).toBe(result.passages[0].text.length);
  expect(result.items).toBe(3);
  expect(result.limited).toBe(false);
});
test('joins tightly adjacent glyphs without adding a space', () => {
  expect(page([item('App', 10, 200, 12), item('lication', 22, 200, 30, true)])
    .passages.map(x => x.text)).toEqual(['Application']);
});
test('synthetic whitespace cannot bridge separate table columns', () => {
  const result = page([item('Category A', 10, 200, 50),
    item(' ', 60, 200, 160), item('Rs. 500', 220, 200, 35, true)]);
  expect(result.passages.map(x => x.text)).toEqual(['Category A', 'Rs. 500']);
  expect(result.passages.map(x => x.position?.x0)).toEqual([10, 220]);
});
test('small whitespace is retained once and cannot replace nonblank geometry', () => {
  const result = page([item('Application', 10, 200, 50), item(' ', 60, 200, 2),
    item('fee', 62, 200, 15, true)]);
  expect(result.passages.map(x => x.text)).toEqual(['Application fee']);
  expect(result.passages[0].position).toEqual({ x0: 10, x1: 77, y: 200, height: 10 });
});
test('new baseline, reversed horizontal direction and wide gaps split fragments', () => {
  const result = page([item('one', 100, 200), item('two', 20, 200),
    item('three', 20, 180), item('four', 200, 180, 40, true)]);
  expect(result.passages.map(x => x.text)).toEqual(['one', 'two', 'three', 'four']);
});
test('rotated or malformed geometry is retained only as isolated literal text', () => {
  for (const geometry of [
    { transform: [0, 10, -10, 0, 50, 200] },
    { transform: [10, 1, 0, 10, 50, 200] },
    { transform: [10, 0, 0, 10, NaN, 200] },
    { transform: [] }, { transform: null }, { width: Infinity }, { width: 0 },
    { height: 0 }, { height: -10 },
  ]) {
    const result = page([item('Rural applicants', 10, 200, 40, true),
      { ...item('Other fragment', 50, 190), ...geometry },
      item('Residence certificate', 10, 180, 40, true)]);
    expect(result.passages.map(x => x.text)).toEqual(['Rural applicants', 'Other fragment', 'Residence certificate']);
    expect(result.passages[1].position).toBeUndefined();
    expect(result.passages.map(x => x.ordinal)).toEqual([1, 3, 5]);
    expect(answerQuestion(buildIndex(result.passages), 'rural residence certificate', 'original', true).kind)
      .toBe('insufficient');
    expect(result.limited).toBe(false);
  }
});
test('invalid blank geometry creates a gap rather than joining unrelated lines', () => {
  const result = page([item('Rural applicants'), { ...item(' '), transform: [] },
    item('Residence certificate', 10, 190, 40, true)]);
  expect(result.passages.map(x => x.ordinal)).toEqual([1, 3]);
  expect(answerQuestion(buildIndex(result.passages), 'rural residence certificate', 'original', true).kind)
    .toBe('insufficient');
});
test('marked-content records count against the work budget but do not add source text', () => {
  const result = page([item('Fee', 10, 200, 20), { type: 'beginMarkedContent' },
    item('Rs. 500', 35, 200, 40, true), { type: 'endMarkedContent' }]);
  expect(result.items).toBe(4);
  expect(result.passages.map(x => x.text)).toEqual(['Fee Rs. 500']);
});
test('unusable string item is disclosed as limited and cannot bridge neighboring fragments', () => {
  const result = page([item('Rural applicants'), { ...item('x'), str: 7 },
    item('Residence certificate', 10, 190, 40, true)]);
  expect(result.limited).toBe(true);
  expect(result.passages.map(x => x.ordinal)).toEqual([1, 3]);
});
test('overlong line is omitted in full, and later valid text remains separately citeable', () => {
  const result = page([item('Rural applicants', 10, 200, 40, true),
    item('x'.repeat(901), 10, 190, 40, true), item('Residence certificate', 10, 180, 40, true)]);
  expect(result.passages.map(x => x.text)).toEqual(['Rural applicants', 'Residence certificate']);
  expect(result.passages.map(x => x.ordinal)).toEqual([1, 3]);
  expect(result.limited).toBe(true);
  expect(answerQuestion(buildIndex(result.passages), 'rural residence certificate', 'original', true).kind)
    .toBe('insufficient');
});
test('long lines built from multiple valid items are never shortened into a false quotation', () => {
  const result = page([item('a'.repeat(500), 10, 200, 30),
    item('b'.repeat(500), 40, 200, 30, true), item('Final', 10, 190, 20, true)]);
  expect(result.passages.map(x => x.text)).toEqual(['Final']);
  expect(result.passages[0].ordinal).toBe(2);
  expect(result.limited).toBe(true);
});
test('exact passage-character boundary remains valid', () => {
  expect(page([item('x'.repeat(900), 10, 200, 40, true)]).passages[0].text.length).toBe(900);
});
test('item exhaustion discards unfinished text and never reads additional items', () => {
  const result = page([item('Complete', 10, 200, 40, true),
    item('Incomplete', 10, 190, 40), item(' continuation', 50, 190, 40, true)], { items: 2 });
  expect(result.items).toBe(2);
  expect(result.passages.map(x => x.text)).toEqual(['Complete']);
  expect(result.limited).toBe(true);
  expect(result.stopped).toBe(true);
});
test('exact item budget at natural end-of-stream permits final flush', () => {
  const result = page([item('Complete')], { items: 1 });
  expect(result.passages.map(x => x.text)).toEqual(['Complete']);
  expect(result.limited).toBe(false);
});
test('externally truncated stream never emits a pending fragment', () => {
  const result = page([item('Complete', 10, 200, 40, true), item('Partial')], {}, false);
  expect(result.passages.map(x => x.text)).toEqual(['Complete']);
  expect(result.limited).toBe(true);
});
test('document character budget rejects whole fragments rather than clipping source text', () => {
  const result = page([item('Rural applicants', 10, 200, 40, true),
    item('a'.repeat(60), 10, 190, 40, true), item('OK', 10, 180, 40, true)], { chars: 25 });
  expect(result.passages.map(x => x.text)).toEqual(['Rural applicants', 'OK']);
  expect(result.passages.map(x => x.ordinal)).toEqual([1, 3]);
  expect(result.chars).toBe(18);
  expect(result.limited).toBe(true);
});
test('exact passage count stops before consuming more source items', () => {
  const result = page([item('First', 10, 200, 40, true),
    item('Second', 10, 190, 40, true)], { passages: 1 });
  expect(result.passages.map(x => x.text)).toEqual(['First']);
  expect(result.items).toBe(1);
  expect(result.limited).toBe(true);
});
test('zero remaining budgets fail closed without consuming a source item', () => {
  for (const budget of [{ chars: 0 }, { passages: 0 }, { items: 0 }]) {
    const result = page([item('Text')], budget);
    expect(result.items).toBe(0);
    expect(result.passages).toEqual([]);
    expect(result.limited).toBe(true);
  }
});
test('invalid limits, physical page numbers and role cannot create an assembler', () => {
  const budget = { chars: 100, passages: 2, items: 10 };
  for (const invalid of [NaN, Infinity, -1, 1.5, MAX_NATIVE_DOCUMENT_CHARS + 1]) {
    expect(() => new NativePageAssembler('original', 1, { ...budget, chars: invalid })).toThrow();
  }
  for (const invalid of [0, 81, 1.5, Infinity]) {
    expect(() => new NativePageAssembler('original', invalid, budget)).toThrow();
  }
  expect(() => new NativePageAssembler('original', 1, { ...budget, items: MAX_NATIVE_PAGE_ITEMS + 1 })).toThrow();
  expect(() => new NativePageAssembler('original', 1, { ...budget, passages: MAX_NATIVE_DOCUMENT_PASSAGES + 1 })).toThrow();
});
test('constructor snapshots budgets and finish cannot be reused', () => {
  const budget = { chars: 100, passages: 2, items: 10 };
  const assembler = new NativePageAssembler('revised', 4, budget);
  budget.chars = 0;
  assembler.push(item('Text'));
  expect(assembler.finish().passages[0]).toMatchObject({ role: 'revised', page: 4, text: 'Text' });
  expect(() => assembler.finish()).toThrow();
  expect(() => assembler.push(item('More'))).toThrow();
});

test('standalone explicit PDF.js EOL markers with zero geometry preserve neighboring-line order', () => {
  const marker = { str: '', transform: [0, 0, 0, 0, 0, 0], width: 0, height: 0, hasEOL: true };
  const result = page([item('Rural applicants', 10, 200, 40), marker,
    item('Residence certificate', 10, 185, 40), marker]);
  expect(result.passages.map(x => x.ordinal)).toEqual([1, 2]);
  const answer = answerQuestion(buildIndex(result.passages), 'rural residence certificate', 'original', true);
  expect(answer.citations).toEqual(result.passages);
  expect(answer.printedFields).toEqual([]);
  expect(result.limited).toBe(false);
});
test('invalid but finite coordinates outside snapshot limits are isolated without false geometry', () => {
  const result = page([item('First', 10, 200, 40, true),
    item('Far away', 1e10, 190, 40, true), item('Last', 10, 180, 40, true)]);
  expect(result.passages.map(x => x.ordinal)).toEqual([1, 3, 5]);
  expect(result.passages[1].position).toBeUndefined();
  expect(result.passages[1].text).toBe('Far away');
});
