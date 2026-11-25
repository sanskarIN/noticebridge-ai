/** Portable question plans. Answers are always recomputed, never imported. */
import { MAX_QUESTION, type Answer, type Role, type SearchIndex } from './pdfChatCore';
import { answerScopedQuestions, resolveChatQuestion, type ChatScope } from './pdfChatInsights';

export const MAX_CHAT_TURNS = 24;
export const MAX_SESSION_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const FORMAT = 'noticebridge-pdf-chat-question-plan';
const POLICY = 'Questions and settings only. Answers must be recomputed from the attached PDFs.';
const ROLES: Role[] = ['original', 'revised'];
const SHA256 = /^[0-9a-f]{64}$/;
export type SourcePins = Partial<Record<Role, string>>;
export type AttachedFiles = Partial<Record<Role, File>>;
export type QuestionStep = { input: string; scope: ChatScope; includeContext: boolean; reuse: boolean };
export type ChatTurn = QuestionStep & { resolved: string; answers: Answer[] };

export class ChatSessionError extends Error {
  constructor(readonly code: 'invalid' | 'different' | 'size' | 'crypto') {
    super(code);
  }
}
function fail(code: ChatSessionError['code'] = 'invalid'): never {
  throw new ChatSessionError(code);
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length ||
      !keys.every(key => Object.prototype.hasOwnProperty.call(value, key))) fail();
}

export async function fingerprintSources(files: AttachedFiles): Promise<SourcePins> {
  if (!globalThis.crypto?.subtle) fail('crypto');
  const pins: SourcePins = {};
  for (const role of ROLES) {
    const file = files[role];
    if (!file) continue;
    if (!file.size || file.size > MAX_SOURCE_BYTES) fail('size');
    const data = await file.arrayBuffer();
    if (data.byteLength !== file.size || data.byteLength > MAX_SOURCE_BYTES) fail('size');
    const digest = await crypto.subtle.digest('SHA-256', data);
    pins[role] = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  }
  if (!Object.keys(pins).length) fail();
  return pins;
}

function sourcePins(input: unknown): SourcePins {
  const raw = object(input);
  const keys = Object.keys(raw);
  if (!keys.length || keys.some(key => key !== 'original' && key !== 'revised')) fail();
  const pins: SourcePins = {};
  for (const role of ROLES) {
    if (!Object.prototype.hasOwnProperty.call(raw, role)) continue;
    const value = raw[role];
    if (typeof value !== 'string' || !SHA256.test(value)) fail();
    pins[role] = value;
  }
  return pins;
}
function questionStep(input: unknown): QuestionStep {
  const row = object(input);
  exact(row, ['input', 'scope', 'includeContext', 'reuse']);
  if (typeof row.input !== 'string' || !row.input.trim() ||
      row.input !== row.input.trim() || row.input.length > MAX_QUESTION ||
      (row.scope !== 'original' && row.scope !== 'revised' && row.scope !== 'both' && row.scope !== 'auto') ||
      typeof row.includeContext !== 'boolean' || typeof row.reuse !== 'boolean') fail();
  return { input: row.input, scope: row.scope, includeContext: row.includeContext, reuse: row.reuse };
}

export function runChatStep(
  index: SearchIndex, step: QuestionStep, previous: ChatTurn | undefined, attached: Role[],
): ChatTurn {
  if (step.scope === 'both' && (!attached.includes('original') || !attached.includes('revised'))) fail('different');
  if (step.scope !== 'auto' && step.scope !== 'both' && !attached.includes(step.scope)) fail('different');
  if (!attached.length) fail('different');
  if (step.reuse && (!previous || previous.answers.length !== 1)) fail();
  const resolved = resolveChatQuestion(step.input, previous?.resolved ?? null, step.reuse);
  return {
    ...step, resolved,
    answers: answerScopedQuestions(index, resolved, step.scope, attached, step.includeContext),
  };
}

export function replayQuestions(index: SearchIndex, steps: QuestionStep[], attached: Role[]): ChatTurn[] {
  if (!steps.length || steps.length > MAX_CHAT_TURNS) fail('size');
  const result: ChatTurn[] = [];
  for (const step of steps) result.push(runChatStep(index, questionStep(step), result.at(-1), attached));
  return result;
}

export function serializeQuestionPlan(pins: SourcePins, steps: QuestionStep[]): string {
  if (!steps.length || steps.length > MAX_CHAT_TURNS) fail('size');
  // Canonical form allows the reader to reject duplicate members, extra
  // fields and ambiguous formatting without another general JSON parser.
  const text = JSON.stringify({
    format: FORMAT, version: 1, policy: POLICY,
    sources: sourcePins(pins), questions: steps.map(questionStep),
  }, null, 2) + '\n';
  if (new TextEncoder().encode(text).length > MAX_SESSION_BYTES) fail('size');
  return text;
}

export function parseQuestionPlan(text: string, expected: SourcePins): QuestionStep[] {
  if (!text || new TextEncoder().encode(text).length > MAX_SESSION_BYTES) fail('size');
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { return fail(); }
  const raw = object(value);
  exact(raw, ['format', 'version', 'policy', 'sources', 'questions']);
  if (raw.format !== FORMAT || raw.version !== 1 || raw.policy !== POLICY) fail();
  const pins = sourcePins(raw.sources);
  if (!Array.isArray(raw.questions) || !raw.questions.length || raw.questions.length > MAX_CHAT_TURNS) fail();
  const steps = raw.questions.map(questionStep);
  if (text !== serializeQuestionPlan(pins, steps)) fail();
  const current = sourcePins(expected);
  if (ROLES.some(role => pins[role] !== current[role])) fail('different');
  return steps;
}

export async function loadQuestionPlan(file: File, pins: SourcePins): Promise<QuestionStep[]> {
  if (!file.size || file.size > MAX_SESSION_BYTES) fail('size');
  const data = await file.arrayBuffer();
  if (data.byteLength !== file.size || data.byteLength > MAX_SESSION_BYTES) fail('size');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
  catch { return fail(); }
  return parseQuestionPlan(text, pins);
}

export function stepsFromTurns(turns: ChatTurn[]): QuestionStep[] {
  return turns.map(({ input, scope, includeContext, reuse }) => ({ input, scope, includeContext, reuse }));
}
