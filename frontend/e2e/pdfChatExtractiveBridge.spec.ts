import { expect, test } from '@playwright/test';
import { answerQuestion, buildIndex, type Passage } from '../src/pdfChatCore';
import { prepareSelection } from '../src/pdfChatSelectionBridge';
import { MAX_EXTRACTIVE_RESULT_BYTES, reviewExtractive } from '../src/pdfChatExtractiveBridge';

const lines: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: '😀 Application fee: Rs. 500 unless exempt.' },
  { role: 'original', page: 2, ordinal: 1, text: 'Application fee: Rs. 750' },
  { role: 'revised', page: 1, ordinal: 1, text: 'Application fee: Rs. 350' },
];
const index = buildIndex(lines);
const answer = answerQuestion(index, 'Application fee?', 'both');
const experiment = prepareSelection(index, answer, null);
const digest = 'a'.repeat(64);
const start = lines[0].text.indexOf('Rs. 500');
const raw = {
  format: 'noticebridge-chat-extractive-result', version: 1,
  request_sha256: digest, model: 'fixture:latest', model_digest: 'b'.repeat(64),
  proposal: { status: 'extract', spans: [{ id: 'original:1:1', start, end: start + 7 }] },
  authority_verified: false,
};
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const review = (value: unknown) => reviewExtractive(encode(value), experiment, digest);

test('extractive review reconstructs exact quote and complete local fragment', () => {
  const result = review(raw);
  expect(result.proposal.spans[0].text).toBe('Rs. 500');
  expect(result.proposal.spans[0].source).toBe(lines[0]);
  expect(result.omittedBaseline.map(source => source.text).sort()).toEqual(
    [lines[1].text, lines[2].text].sort());
  expect(result.missingRoles).toEqual(['revised']);
  expect(answer.citations).toHaveLength(3);
});

test('abstention leaves every baseline fragment intact', () => {
  const result = review({ ...raw, proposal: { status: 'insufficient', spans: [] } });
  expect(result.omittedBaseline).toEqual(answer.citations);
  expect(result.proposal.spans).toEqual([]);
  expect(result.missingRoles).toEqual(['original', 'revised']);
});

for (const [name, proposal] of [
  ['unknown id', { status: 'extract', spans: [{ id: 'original:99:1', start: 0, end: 1 }] }],
  ['split surrogate', { status: 'extract', spans: [{ id: 'original:1:1', start: 1, end: 2 }] }],
  ['overflow', { status: 'extract', spans: [{ id: 'original:1:1', start: 0, end: 900 }] }],
  ['inverted', { status: 'extract', spans: [{ id: 'original:1:1', start: 4, end: 3 }] }],
  ['overlapping', { status: 'extract', spans: [raw.proposal.spans[0], raw.proposal.spans[0]] }],
  ['model supplied text', { status: 'extract', spans: [{ ...raw.proposal.spans[0], text: 'fake' }] }],
  ['invalid abstention', { status: 'insufficient', spans: raw.proposal.spans }],
]) {
  test('rejects ' + name, () => expect(() => review({ ...raw, proposal })).toThrow());
}

test('request binding and canonical encoding reject ambiguous metadata', () => {
  for (const value of [
    { ...raw, request_sha256: 'c'.repeat(64) }, { ...raw, authority_verified: true },
    { ...raw, model: 'cloud:latest' }, { ...raw, extra: 'answer' },
  ]) expect(() => review(value)).toThrow();
  expect(() => reviewExtractive(encode(raw).replace('"start":', '"start": 0, "start":'), experiment, digest)).toThrow();
  expect(() => reviewExtractive(encode(raw).trim(), experiment, digest)).toThrow();
  expect(() => reviewExtractive('x'.repeat(MAX_EXTRACTIVE_RESULT_BYTES + 1), experiment, digest)).toThrow();
});

test('scope-bound proposal cannot access a different document', () => {
  const selected = prepareSelection(index, answerQuestion(index, 'Application fee?', 'original'), null);
  const spoof = { ...raw, proposal: { status: 'extract', spans: [{ id: 'revised:1:1', start: 0, end: 3 }] } };
  expect(() => reviewExtractive(encode(spoof), selected, digest)).toThrow();
});
