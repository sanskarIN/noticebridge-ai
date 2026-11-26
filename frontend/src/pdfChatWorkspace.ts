/** Portable, source-bound workspace. No document bytes, extracted quotes or model answers. */
import type { Role, SearchIndex } from './pdfChatCore';
import { parseQuestionPlan, replayQuestions, serializeQuestionPlan, stepsFromTurns,
  type ChatTurn, type SourcePins } from './pdfChatSession';
import { parseReview, serializeReview, type ReviewEntry } from './pdfChatReviewWorkspace';

export const MAX_WORKSPACE_BYTES = 384 * 1024;
const FORMAT = 'noticebridge-private-workspace';
const POLICY = 'Questions and personal notes only; replay against exact attached PDF bytes.';
const ROLES: Role[] = ['original', 'revised'];
const SHA = /^[a-f0-9]{64}$/;
export type Workspace = { turns: ChatTurn[]; entries: ReviewEntry[] };
function invalid(): never { throw new Error('Invalid or mismatched private workspace.'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length ||
      keys.some(key => !Object.prototype.hasOwnProperty.call(raw, key))) invalid();
  return raw;
}
function pinsOf(value: unknown): SourcePins {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (!keys.length || keys.some(key => key !== 'original' && key !== 'revised')) invalid();
  const pins: SourcePins = {};
  for (const role of ROLES) {
    if (!Object.prototype.hasOwnProperty.call(raw, role)) continue;
    if (typeof raw[role] !== 'string' || !SHA.test(raw[role])) invalid();
    pins[role] = raw[role];
  }
  return pins;
}
function encode(pins: SourcePins, plan: unknown, review: unknown): string {
  const text = JSON.stringify({ format: FORMAT, version: 1, policy: POLICY,
    sources: pins, question_plan: plan, evidence_review: review, authority_verified: false }, null, 2) + '\n';
  if (new TextEncoder().encode(text).length > MAX_WORKSPACE_BYTES) invalid();
  return text;
}
function nested(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return JSON.stringify(value, null, 2) + '\n';
}

export async function serializeWorkspace(index: SearchIndex, pins: SourcePins, workspace: Workspace): Promise<string> {
  const normalized = pinsOf(pins);
  if (!workspace.turns.length && !workspace.entries.length) invalid();
  const plan = workspace.turns.length
    ? JSON.parse(serializeQuestionPlan(normalized, stepsFromTurns(workspace.turns))) : null;
  const review = workspace.entries.length
    ? JSON.parse(await serializeReview(index, normalized, workspace.entries)) : null;
  return encode(normalized, plan, review);
}

/** Stage all components before returning. The caller may apply the complete
 * result only after confirmation; a rejected component never yields a partial restore.
 */
export async function parseWorkspace(text: string, index: SearchIndex, expected: SourcePins): Promise<Workspace> {
  if (!text || text.length > MAX_WORKSPACE_BYTES ||
      new TextEncoder().encode(text).length > MAX_WORKSPACE_BYTES) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return invalid(); }
  const raw = object(parsed, ['format', 'version', 'policy', 'sources',
    'question_plan', 'evidence_review', 'authority_verified']);
  if (raw.format !== FORMAT || raw.version !== 1 || raw.policy !== POLICY ||
      raw.authority_verified !== false || (raw.question_plan === null && raw.evidence_review === null)) invalid();
  const supplied = pinsOf(raw.sources), current = pinsOf(expected);
  if (ROLES.some(role => supplied[role] !== current[role])) invalid();
  if (encode(supplied, raw.question_plan, raw.evidence_review) !== text) invalid();
  const steps = raw.question_plan === null ? [] : parseQuestionPlan(nested(raw.question_plan), current);
  const entries = raw.evidence_review === null ? [] : await parseReview(nested(raw.evidence_review), index, current);
  const turns = steps.length ? replayQuestions(index, steps, ROLES.filter(role => current[role])) : [];
  return { turns, entries };
}

export async function loadWorkspace(file: File, index: SearchIndex, pins: SourcePins): Promise<Workspace> {
  if (!file.size || file.size > MAX_WORKSPACE_BYTES) invalid();
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size || bytes.byteLength > MAX_WORKSPACE_BYTES) invalid();
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return invalid(); }
  return parseWorkspace(text, index, pins);
}
