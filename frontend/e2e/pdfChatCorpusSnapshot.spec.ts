import { expect, test } from '@playwright/test';
import { indexCorpusSnapshot, parseCorpusSnapshot, serializeCorpusSnapshot,
  MAX_CORPUS_SNAPSHOT_BYTES } from '../src/pdfChatCorpusSnapshot';
import { answerQuestion, buildIndex, type Corpus, type Passage } from '../src/pdfChatCore';
import type { SourcePins } from '../src/pdfChatSession';

const pins: SourcePins = { original: 'a'.repeat(64), revised: 'b'.repeat(64) };
const rows: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Rural applicants',
    position: { x0: 20, x1: 80, y: 720, height: 12 } },
  { role: 'original', page: 1, ordinal: 2, text: 'Residence certificate required',
    position: { x0: 20, x1: 200, y: 700, height: 12 } },
  { role: 'original', page: 3, ordinal: 4, text: '😀 Fee: INR 500' },
  { role: 'revised', page: 1, ordinal: 1, text: 'Fee: INR 350' },
];
const original: Corpus = { passages: rows.slice(0, 3), pageCount: 4, processedPages: 3,
  missingPages: [2], limitedPages: [3], limited: true };
const revised: Corpus = { passages: rows.slice(3), pageCount: 1, processedPages: 1,
  missingPages: [], limitedPages: [], limited: false };
const text = serializeCorpusSnapshot(pins, { original, revised });
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

test('native snapshot preserves exact fragments, geometry, Unicode and coverage', () => {
  const parsed = parseCorpusSnapshot(text);
  expect(parsed.pins).toEqual(pins);
  expect(parsed.attached).toEqual(['original', 'revised']);
  expect(parsed.corpora).toEqual({ original, revised });
  expect(parsed.passages).toEqual(rows);
  expect(serializeCorpusSnapshot(parsed.pins, parsed.corpora)).toBe(text);
  const query = 'Rural residence certificate?';
  expect(answerQuestion(indexCorpusSnapshot(parsed), query, 'original', true))
    .toEqual(answerQuestion(buildIndex(rows), query, 'original', true));
});

test('native snapshot permits an attached image-only PDF with missing text', () => {
  const empty: Corpus = { passages: [], pageCount: 2, processedPages: 2,
    missingPages: [1, 2], limitedPages: [], limited: false };
  const result = parseCorpusSnapshot(serializeCorpusSnapshot({ original: pins.original }, { original: empty }));
  expect(result.attached).toEqual(['original']);
  expect(result.passages).toEqual([]);
});

for (const [name, mutate] of [
  ['duplicate source role', (raw: any) => raw.sources.push(raw.sources[0])],
  ['invalid fingerprint', (raw: any) => raw.sources[0].sha256 = 'bad'],
  ['claimed authority', (raw: any) => raw.authority_verified = true],
  ['inconsistent missing page', (raw: any) => raw.sources[0].missing_pages = []],
  ['contradictory limited status', (raw: any) => raw.sources[0].limited = false],
  ['unknown coverage field', (raw: any) => raw.sources[0].unknown = 1],
  ['source identity mismatch', (raw: any) => raw.sources[0].passages[0].role = 'revised'],
  ['physical page out of scope', (raw: any) => raw.sources[0].passages[0].page = 4],
  ['repeated fragment ordinal', (raw: any) => raw.sources[0].passages[1].ordinal = 1],
  ['invalid position', (raw: any) => raw.sources[0].passages[0].position.height = -1],
  ['reversed text extent', (raw: any) => raw.sources[0].passages[0].position.x1 = 1],
  ['isolated surrogate', (raw: any) => raw.sources[0].passages[0].text = '\ud800'],
  ['untrimmed fragment', (raw: any) => raw.sources[0].passages[0].text += ' '],
] as const) {
  test('snapshot rejects ' + name, () => {
    const raw = JSON.parse(text);
    mutate(raw);
    expect(() => parseCorpusSnapshot(encode(raw))).toThrow();
  });
}

test('snapshot rejects duplicate keys, reordered sources and excess bytes', () => {
  const raw = JSON.parse(text);
  raw.sources.reverse();
  expect(() => parseCorpusSnapshot(encode(raw))).toThrow();
  expect(() => parseCorpusSnapshot(text.replace('"version": 1,', '"version": 1, "version": 1,'))).toThrow();
  expect(() => parseCorpusSnapshot('x'.repeat(MAX_CORPUS_SNAPSHOT_BYTES + 1))).toThrow();
});

test('export rejects mismatched source pins and an impossible missing-page list', () => {
  expect(() => serializeCorpusSnapshot(pins, { original })).toThrow();
  expect(() => serializeCorpusSnapshot({ original: pins.original }, {
    original: { ...original, missingPages: [1, 2] },
  })).toThrow();
});
