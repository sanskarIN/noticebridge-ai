import { expect, test } from '@playwright/test';
import { buildIndex, type Passage } from '../src/pdfChatCore';
import { pinEvidence, updateEvidence } from '../src/pdfChatReviewWorkspace';
import { replayQuestions, type QuestionStep } from '../src/pdfChatSession';
import { loadWorkspace, parseWorkspace, serializeWorkspace, MAX_WORKSPACE_BYTES } from '../src/pdfChatWorkspace';

const source: Passage = { role: 'original', page: 1, ordinal: 1, text: 'Application fee: INR 500' };
const index = buildIndex([source]);
const pins = { original: 'a'.repeat(64) };
const steps: QuestionStep[] = [
  { input: 'Application fee?', scope: 'original', includeContext: false, reuse: false },
  { input: 'On page 1?', scope: 'original', includeContext: true, reuse: true },
];
const turns = replayQuestions(index, steps, ['original']);
const entries = updateEvidence(pinEvidence(index, [], source), 'original:1:1',
  { status: 'needs_followup', note: 'Confirm applicability 😀' });
const encode = (raw: unknown) => JSON.stringify(raw, null, 2) + '\n';

test('complete workspace retains only private authored data and recomputes answers', async () => {
  const text = await serializeWorkspace(index, pins, { turns, entries });
  expect(text).not.toContain(source.text);
  expect(text).not.toContain('"answers"');
  expect(text).not.toContain('"resolved"');
  expect(text).toContain('Confirm applicability 😀');
  const restored = await parseWorkspace(text, index, pins);
  expect(restored).toEqual({ turns, entries });
  expect(restored.entries[0].source).toBe(source);
  expect(await serializeWorkspace(index, pins, restored)).toBe(text);
});
test('question-only and note-only workspaces are supported; empty exports rejected', async () => {
  for (const workspace of [{ turns, entries: [] }, { turns: [], entries }]) {
    const text = await serializeWorkspace(index, pins, workspace);
    expect(await parseWorkspace(text, index, pins)).toEqual(workspace);
  }
  await expect(serializeWorkspace(index, pins, { turns: [], entries: [] })).rejects.toThrow();
});
test('workspace replay recomputes question-only answers against the current index', async () => {
  const text = await serializeWorkspace(index, pins, { turns, entries: [] });
  const replacement = { ...source, text: 'Application fee: INR 600' };
  const restored = await parseWorkspace(text, buildIndex([replacement]), pins);
  expect(restored.turns[0].answers[0].citations[0].text).toBe(replacement.text);
});
test('review text binding rejects changed extraction even when PDF fingerprints match', async () => {
  const text = await serializeWorkspace(index, pins, { turns, entries });
  await expect(parseWorkspace(text, buildIndex([{ ...source, text: 'Application fee: INR 600' }]), pins)).rejects.toThrow();
});
test('outer and both nested source fingerprints must match', async () => {
  const text = await serializeWorkspace(index, pins, { turns, entries });
  await expect(parseWorkspace(text, index, { original: 'b'.repeat(64) })).rejects.toThrow();
  await expect(parseWorkspace(text, index, { original: pins.original, revised: 'b'.repeat(64) })).rejects.toThrow();
  for (const key of ['question_plan', 'evidence_review']) {
    const raw = JSON.parse(text);
    raw[key].sources.original = 'b'.repeat(64);
    await expect(parseWorkspace(encode(raw), index, pins)).rejects.toThrow();
  }
});
test('unknown metadata, saved answers and forged claims reject the entire workspace', async () => {
  const text = await serializeWorkspace(index, pins, { turns, entries });
  for (const change of [
    (raw: any) => raw.authority_verified = true,
    (raw: any) => raw.saved_answers = [],
    (raw: any) => raw.question_plan.questions[0].answers = [],
    (raw: any) => raw.evidence_review.entries[0].text_sha256 = 'b'.repeat(64),
    (raw: any) => raw.evidence_review.authority_verified = true,
    (raw: any) => raw.question_plan.questions[0].reuse = true,
    (raw: any) => raw.question_plan = [],
  ]) {
    const raw = JSON.parse(text); change(raw);
    await expect(parseWorkspace(encode(raw), index, pins)).rejects.toThrow();
  }
});
test('workspace rejects duplicate outer or nested fields and noncanonical input', async () => {
  const text = await serializeWorkspace(index, pins, { turns, entries });
  for (const bad of [text.replace('"version": 1,', '"version": 1, "version": 1,'),
    text.replace('"includeContext": false,', '"includeContext": true, "includeContext": false,'),
    text.trim(), 'x'.repeat(MAX_WORKSPACE_BYTES + 1)]) {
    await expect(parseWorkspace(bad, index, pins)).rejects.toThrow();
  }
});
test('file validation rejects invalid UTF-8 and empty files', async () => {
  await expect(loadWorkspace(new File([new Uint8Array([0xff])], 'invalid.json'), index, pins)).rejects.toThrow();
  await expect(loadWorkspace(new File([], 'empty.json'), index, pins)).rejects.toThrow();
});
