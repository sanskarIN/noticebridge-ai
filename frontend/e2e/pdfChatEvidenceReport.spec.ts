import { expect, test } from '@playwright/test';
import { buildIndex, type Corpus, type Passage } from '../src/pdfChatCore';
import { replayQuestions, type QuestionStep } from '../src/pdfChatSession';
import { exportEvidenceReport, verifyEvidenceReport, readEvidenceReport,
  MAX_EVIDENCE_REPORT_BYTES, type ChatCorpora } from '../src/pdfChatEvidenceReport';

const pins = { original: 'a'.repeat(64), revised: 'b'.repeat(64) };
const lines: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Application fee: Rs. 500' },
  { role: 'original', page: 2, ordinal: 1, text: 'Applicants from rural districts' },
  { role: 'original', page: 2, ordinal: 2, text: 'A residence certificate must be submitted' },
  { role: 'revised', page: 1, ordinal: 1, text: 'Application fee: Rs. 350' },
];
function corpus(passages: Passage[], pages = 3): Corpus {
  return { passages, pageCount: pages, processedPages: pages,
    missingPages: Array.from({ length: pages }, (_, i) => i + 1).filter(page => !passages.some(p => p.page === page)),
    limitedPages: [], limited: false };
}
const corpora: ChatCorpora = {
  original: corpus(lines.filter(line => line.role === 'original')),
  revised: corpus(lines.filter(line => line.role === 'revised')),
};
const steps: QuestionStep[] = [
  { input: 'Application fee?', scope: 'both', includeContext: false, reuse: false },
  { input: 'Rural residence certificate on page 2?', scope: 'original', includeContext: true, reuse: false },
  { input: 'Refund policy?', scope: 'both', includeContext: true, reuse: false },
];
const idx = buildIndex(lines);
const turns = replayQuestions(idx, steps, ['original', 'revised']);
const report = exportEvidenceReport(pins, corpora, idx, turns);
const verify = (text: string) => verifyEvidenceReport(text, pins, corpora, idx);

test('report stores exact strict citations, source pins, page coverage and abstentions', () => {
  const raw = JSON.parse(report);
  expect(JSON.parse(raw.question_plan).sources).toEqual(pins);
  expect(raw.authority_verified).toBe(false);
  expect(raw.source_coverage[0].missing_pages).toEqual([3]);
  expect(raw.turns[0].answers[0].citations).toEqual([lines[0], lines[3]]);
  expect(raw.turns[1].answers[0].context_groups).toEqual([
    { role: 'original', page: 2, citations: [1, 2] },
  ]);
  expect(raw.turns[2].answers[0].kind).toBe('insufficient');
  expect(verify(report)).toEqual({ turns: 3, questions: 3, citations: 4, insufficient: 1 });
});

test('replay verification leaves current answer objects unchanged', () => {
  const original = JSON.stringify(turns);
  verify(report);
  expect(JSON.stringify(turns)).toBe(original);
});

test('export rejects stale live answers instead of silently replacing them', () => {
  const changed = buildIndex([{ ...lines[0], text: 'Application fee: Rs. 999' }, ...lines.slice(1)]);
  expect(() => exportEvidenceReport(pins, corpora, changed, turns)).toThrow('mismatch');
});

test('verification rejects different extracted text even if source pins are unchanged', () => {
  const changed = buildIndex([{ ...lines[0], text: 'Application fee: Rs. 999' }, ...lines.slice(1)]);
  expect(() => verifyEvidenceReport(report, pins, corpora, changed)).toThrow('mismatch');
});

test('verification rejects changed source bytes and swapped roles', () => {
  for (const other of [
    { original: 'c'.repeat(64), revised: pins.revised },
    { original: pins.revised, revised: pins.original },
    { original: pins.original },
  ]) expect(() => verifyEvidenceReport(report, other, corpora, idx)).toThrow('different');
});

test('verification rejects changed coverage even when citations are unchanged', () => {
  const original = { ...corpora.original!, limited: true, limitedPages: [3] };
  expect(() => verifyEvidenceReport(report, pins, { ...corpora, original }, idx)).toThrow('mismatch');
});

test('report generation requires coverage for all pinned roles', () => {
  expect(() => exportEvidenceReport(pins, { original: corpora.original }, idx, turns)).toThrow();
});

const tampering: [string, (raw: any) => void][] = [
  ['source quote', raw => { raw.turns[0].answers[0].citations[0].text = 'Application fee: free'; }],
  ['physical page', raw => { raw.turns[0].answers[0].citations[0].page = 3; }],
  ['source role', raw => { raw.turns[0].answers[0].citations[0].role = 'revised'; }],
  ['source ordinal', raw => { raw.turns[0].answers[0].citations[0].ordinal = 7; }],
  ['printed field', raw => { raw.turns[0].answers[0].printed_fields[0].value = 'Free'; }],
  ['missing role', raw => { raw.turns[2].answers[0].missing_roles = []; }],
  ['context references', raw => { raw.turns[1].answers[0].context_groups[0].citations = [9]; }],
  ['match count', raw => { raw.turns[0].answers[0].matched_counts.original = 99; }],
  ['coverage', raw => { raw.source_coverage[0].missing_pages = []; }],
  ['authority', raw => { raw.authority_verified = true; }],
  ['extra model answer', raw => { raw.model_answer = 'Unverified'; }],
  ['removed turn', raw => { raw.turns.pop(); }],
  ['resolved question', raw => { raw.turns[0].resolved = 'Different question'; }],
];
for (const [name, mutate] of tampering) {
  test('rejects tampering: ' + name, () => {
    const raw = JSON.parse(report);
    mutate(raw);
    expect(() => verify(JSON.stringify(raw, null, 2) + '\n')).toThrow();
  });
}

test('canonical replay rejects duplicate keys, extra whitespace and BOM', () => {
  for (const text of [
    report.replace('"version": 1,', '"version": 1, "version": 1,'),
    report.trim(), '\ufeff' + report, JSON.stringify(JSON.parse(report)),
  ]) expect(() => verify(text)).toThrow();
});

test('file and parser limits reject empty, oversized and malformed inputs', async () => {
  expect(() => verify('')).toThrow('size');
  expect(() => verify('x'.repeat(MAX_EVIDENCE_REPORT_BYTES + 1))).toThrow('size');
  expect(() => verify('{')).toThrow('invalid');
  await expect(readEvidenceReport(new File([], 'empty.json'))).rejects.toThrow('size');
  await expect(readEvidenceReport(new File([new Uint8Array([0xff])], 'bad.json'))).rejects.toThrow('invalid');
  expect(await readEvidenceReport(new File([report], 'valid.json'))).toBe(report);
});
