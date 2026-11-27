import { expect, test } from '@playwright/test';
import { buildIndex, type Passage } from '../src/pdfChatCore';
import {
  ChatSessionError, MAX_CHAT_TURNS, MAX_SESSION_BYTES, parseQuestionPlan,
  replayQuestions, runChatStep, serializeQuestionPlan, stepsFromTurns, reviseChatHistory, independentQuestionFromTurn, type QuestionStep,
} from '../src/pdfChatSession';

const pins = { original: 'a'.repeat(64), revised: 'b'.repeat(64) };
const lines: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Application fee: Rs. 500' },
  { role: 'revised', page: 1, ordinal: 1, text: 'Application fee: Rs. 350' },
  { role: 'original', page: 2, ordinal: 1, text: 'Applicants from rural districts' },
  { role: 'original', page: 2, ordinal: 2, text: 'must submit a residence certificate' },
];
const index = buildIndex(lines);
const steps: QuestionStep[] = [
  { input: 'Application fee in the original notice?', scope: 'auto', includeContext: true, reuse: false },
  { input: 'What about the updated notice?', scope: 'auto', includeContext: true, reuse: true },
  { input: 'Rural residence certificate on page 2?', scope: 'original', includeContext: true, reuse: false },
  { input: 'Rural residence certificate on page 2?', scope: 'original', includeContext: false, reuse: false },
];
const serialized = serializeQuestionPlan(pins, steps);

test('canonical export contains no answer text or stored quotations', () => {
  const raw = JSON.parse(serialized);
  expect(raw.format).toBe('noticebridge-pdf-chat-question-plan');
  expect(raw.version).toBe(1);
  expect(raw.sources).toEqual(pins);
  expect(raw.questions).toEqual(steps);
  expect(serialized).not.toContain('Rs. 500');
  expect(serialized).not.toContain('Rs. 350');
  expect(serialized).not.toContain('citations');
  expect(serialized).not.toContain('answers');
});
test('replay restores the same query scope, context setting and independently cited results', () => {
  const replayed = replayQuestions(index, parseQuestionPlan(serialized, pins), ['original', 'revised']);
  expect(replayed).toHaveLength(4);
  expect(replayed[0].answers[0].citations).toEqual([lines[0]]);
  expect(replayed[1].answers[0].citations).toEqual([lines[1]]);
  expect(replayed[2].answers[0].citations).toEqual(lines.slice(2));
  expect(replayed[2].answers[0].pageFilter).toBe(2);
  expect(replayed[3].answers[0].kind).toBe('insufficient');
  expect(stepsFromTurns(replayed)).toEqual(steps);
});
test('replay uses the currently attached index instead of trusting historical answer text', () => {
  const changed = buildIndex([{ ...lines[0], text: 'Application fee: Rs. 700' }, ...lines.slice(1)]);
  const result = replayQuestions(changed, steps, ['original', 'revised']);
  expect(result[0].answers[0].citations[0].text).toBe('Application fee: Rs. 700');
});
test('a question step with missing manual source is rejected', () => {
  expect(() => runChatStep(index, steps[2], undefined, ['revised'])).toThrow(ChatSessionError);
  expect(() => runChatStep(index, { ...steps[0], scope: 'both' }, undefined, ['original'])).toThrow(ChatSessionError);
});
test('auto scope can explicitly abstain on an unavailable requested role', () => {
  const result = runChatStep(buildIndex([lines[0]]),
    { ...steps[0], input: 'Application fee in updated notice?' }, undefined, ['original']);
  expect(result.answers[0].kind).toBe('insufficient');
  expect(result.answers[0].missingRoles).toEqual(['revised']);
});
test('replay requires an existing single-question turn for context reuse', () => {
  expect(() => replayQuestions(index, [steps[1]], ['original', 'revised'])).toThrow();
  expect(() => replayQuestions(index, [{ ...steps[0], input: 'Fee? Eligibility?' }, steps[1]],
    ['original', 'revised'])).toThrow();
});
for (const expected of [
  { original: 'c'.repeat(64), revised: pins.revised },
  { original: pins.revised, revised: pins.original },
  { original: pins.original },
  { revised: pins.revised },
]) {
  test('rejects a different attached source set: ' + JSON.stringify(expected).slice(0, 85), () => {
    expect(() => parseQuestionPlan(serialized, expected)).toThrow('different');
  });
}
test('accepts a canonical one-source plan', () => {
  const expected = { original: pins.original };
  const text = serializeQuestionPlan(expected, [steps[0]]);
  expect(parseQuestionPlan(text, expected)).toEqual([steps[0]]);
});
test('rejects noncanonical JSON, including duplicate members', () => {
  expect(() => parseQuestionPlan(JSON.stringify(JSON.parse(serialized)), pins)).toThrow();
  expect(() => parseQuestionPlan(serialized.replace('"version": 1,', '"version": 1, "version": 1,'), pins)).toThrow();
  expect(() => parseQuestionPlan(serialized.replace('"original":', '"extra": "bad", "original":'), pins)).toThrow();
  expect(() => parseQuestionPlan('\ufeff' + serialized, pins)).toThrow();
  expect(() => parseQuestionPlan(serialized.trim(), pins)).toThrow();
});
const invalid: [string, (raw: any) => void][] = [
  ['extra answer', raw => { raw.questions[0].answer = 'invented'; }],
  ['authority flag', raw => { raw.authority_verified = true; }],
  ['unknown scope', raw => { raw.questions[0].scope = 'everything'; }],
  ['numeric context', raw => { raw.questions[0].includeContext = 1; }],
  ['string reuse', raw => { raw.questions[0].reuse = 'false'; }],
  ['empty input', raw => { raw.questions[0].input = ''; }],
  ['overlong input', raw => { raw.questions[0].input = 'x'.repeat(401); }],
  ['untrimmed input', raw => { raw.questions[0].input = ' Fee '; }],
  ['wrong version', raw => { raw.version = 2; }],
  ['wrong format', raw => { raw.format = 'answer'; }],
  ['bad digest', raw => { raw.sources.original = 'A'.repeat(64); }],
  ['empty question list', raw => { raw.questions = []; }],
  ['too many turns', raw => { raw.questions = Array(MAX_CHAT_TURNS + 1).fill(raw.questions[0]); }],
];
for (const [name, mutate] of invalid) {
  test('rejects malformed plan: ' + name, () => {
    const raw = JSON.parse(serialized);
    mutate(raw);
    expect(() => parseQuestionPlan(JSON.stringify(raw, null, 2) + '\n', pins)).toThrow();
  });
}
test('bounds both export and import', () => {
  expect(() => serializeQuestionPlan(pins, [])).toThrow('size');
  expect(() => serializeQuestionPlan(pins, Array(MAX_CHAT_TURNS + 1).fill(steps[0]))).toThrow('size');
  expect(() => parseQuestionPlan(' '.repeat(MAX_SESSION_BYTES + 1), pins)).toThrow('size');
});

test('route-only follow-ups are recomputed identically after question-plan export', () => {
  const routing: QuestionStep[] = [
    { input: 'Application fee in original notice on page 1?', scope: 'auto', includeContext: false, reuse: false },
    { input: 'What about the revised notice?', scope: 'auto', includeContext: false, reuse: true },
    { input: 'On page 2?', scope: 'auto', includeContext: false, reuse: true },
    { input: 'On page 1?', scope: 'auto', includeContext: false, reuse: true },
  ];
  const turns = replayQuestions(index, routing, ['original', 'revised']);
  const restored = replayQuestions(index, parseQuestionPlan(serializeQuestionPlan(pins, routing), pins),
    ['original', 'revised']);
  expect(restored).toEqual(turns);
  expect(restored.map(turn => turn.answers[0].citations.map(p => p.text))).toEqual([
    ['Application fee: Rs. 500'], ['Application fee: Rs. 350'], [], ['Application fee: Rs. 350'],
  ]);
});

test('revision retains only the unchanged prefix and recomputes the selected turn', () => {
  const history = replayQuestions(index, steps, ['original', 'revised']);
  const before = JSON.stringify(history);
  const next = reviseChatHistory(index, history, 1,
    { ...steps[1], input: 'What about the original notice?' }, ['original', 'revised'], true);
  expect(next).toHaveLength(2);
  expect(next[0]).toBe(history[0]);
  expect(next[1].answers[0].citations).toEqual([lines[0]]);
  expect(next[1].reuse).toBe(true);
  expect(JSON.stringify(history)).toBe(before);
  const exported = serializeQuestionPlan(pins, stepsFromTurns(next));
  expect(replayQuestions(index, parseQuestionPlan(exported, pins), ['original', 'revised'])).toEqual(next);
});
test('revising the last turn requires no truncation confirmation, but earlier turns do', () => {
  const history = replayQuestions(index, steps, ['original', 'revised']);
  expect(() => reviseChatHistory(index, history, 0, steps[0], ['original', 'revised'], false)).toThrow();
  const updated = reviseChatHistory(index, history, 3, { ...steps[3], includeContext: true }, ['original', 'revised'], false);
  expect(updated).toHaveLength(4);
  expect(updated.slice(0, 3)).toEqual(history.slice(0, 3));
  expect(updated[3].answers[0].citations).toEqual(lines.slice(2));
});
test('revision fails atomically for invalid bounds, context or unavailable source', () => {
  const history = replayQuestions(index, steps, ['original', 'revised']);
  const before = JSON.stringify(history);
  for (const at of [-1, 4, 1.5, NaN]) {
    expect(() => reviseChatHistory(index, history, at, steps[0], ['original', 'revised'], true)).toThrow();
  }
  expect(() => reviseChatHistory(index, history, 0, { ...steps[0], reuse: true }, ['original', 'revised'], true)).toThrow();
  expect(() => reviseChatHistory(index, history, 1, { ...steps[0], scope: 'revised' }, ['original'], true)).toThrow();
  expect(() => reviseChatHistory(index, history, 0, { ...steps[0], input: ' ' }, ['original', 'revised'], true)).toThrow();
  expect(JSON.stringify(history)).toBe(before);
});
test('repeat resolved follow-up independently preserves the effective wording and settings', () => {
  const history = replayQuestions(index, steps, ['original', 'revised']);
  const copied = independentQuestionFromTurn(history[1]);
  expect(copied).toEqual({ input: history[1].resolved, scope: 'auto', includeContext: true, reuse: false });
  expect(runChatStep(index, copied, history[3], ['original', 'revised']).answers).toEqual(history[1].answers);
  expect(independentQuestionFromTurn(history[3])).toEqual(steps[3]);
});
