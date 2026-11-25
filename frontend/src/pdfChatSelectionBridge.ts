/** Local LLM selection exchange. The model may select evidence, not assert facts. */
import type { Answer, Passage, Role, SearchIndex } from './pdfChatCore';
import { allowedPassages, passageId } from './pdfChatResearch';
import type { CandidateReview } from './pdfChatEmbeddingBridge';

export const MAX_SELECTION_BYTES = 128 * 1024;
export const MAX_SELECTION_RESULT_BYTES = 16 * 1024;
export const MAX_SELECTION_PER_ROLE = 12;
const FORMAT = 'noticebridge-chat-selection-request';
const RESULT = 'noticebridge-chat-selection-result';
const SHA = /^[a-f0-9]{64}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63})?:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ROLES: Role[] = ['original', 'revised'];

export type SelectionExperiment = {
  text: string;
  allowed: ReadonlyMap<string, Passage>;
  baseline: readonly Passage[];
  omittedCandidates: number;
};
export type SelectionReview = {
  model: string;
  digest: string;
  status: 'select' | 'insufficient';
  selected: Passage[];
  omittedBaseline: Passage[];
};

function invalid(): never {
  throw new Error('Invalid or mismatched evidence selection.');
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length ||
      !keys.every(key => Object.prototype.hasOwnProperty.call(raw, key))) invalid();
  return raw;
}

export function prepareSelection(
  index: SearchIndex, answer: Answer, review: CandidateReview | null,
): SelectionExperiment {
  const scope: Role[] = answer.scope === 'both' ? ROLES : [answer.scope];
  const source = allowedPassages(index.rows.map(row => row.passage), scope, answer.pageFilter);
  const allowed = new Map<string, Passage>();
  const counts: Record<Role, number> = { original: 0, revised: 0 };
  const seen = new Set<string>();
  let omittedCandidates = 0;
  // Baseline first, including every contextual fragment; suggestions can
  // consume only the remaining budget. Never accept external source text.
  for (const passage of [...answer.citations, ...(review?.candidates.map(row => row.passage) ?? [])]) {
    const id = passageId(passage);
    const local = source.get(id);
    if (!local || local.text !== passage.text) invalid();
    if (seen.has(id)) continue;
    seen.add(id);
    if (counts[local.role] >= MAX_SELECTION_PER_ROLE) {
      omittedCandidates++;
      continue;
    }
    allowed.set(id, local);
    counts[local.role]++;
  }
  if (!allowed.size) throw new Error('No candidate evidence. Try semantic retrieval first.');
  if (answer.citations.some(passage => !allowed.has(passageId(passage)))) invalid();
  const text = JSON.stringify({
    format: FORMAT, version: 1, question: answer.question,
    passages: [...allowed].map(([id, passage]) => ({ id, text: passage.text })),
  }, null, 2) + '\n';
  if (new TextEncoder().encode(text).length > MAX_SELECTION_BYTES) invalid();
  return { text, allowed, baseline: answer.citations, omittedCandidates };
}

export function reviewSelection(
  text: string, experiment: SelectionExperiment, digest: string,
): SelectionReview {
  if (!text || text.length > MAX_SELECTION_RESULT_BYTES ||
      new TextEncoder().encode(text).length > MAX_SELECTION_RESULT_BYTES) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return invalid(); }
  const raw = object(parsed, ['format', 'version', 'request_sha256', 'model', 'model_digest',
    'selection', 'authority_verified']);
  if (raw.format !== RESULT || raw.version !== 1 || !SHA.test(digest) ||
      raw.request_sha256 !== digest || raw.authority_verified !== false ||
      typeof raw.model !== 'string' || raw.model.length > 96 || !MODEL.test(raw.model) ||
      /cloud/i.test(raw.model) || typeof raw.model_digest !== 'string' ||
      !SHA.test(raw.model_digest)) invalid();
  const selection = object(raw.selection, ['status', 'ids']);
  const ids = selection.ids;
  if (!Array.isArray(ids) || ids.length > 8 ||
      (selection.status !== 'select' && selection.status !== 'insufficient') ||
      (selection.status === 'select' ? ids.length === 0 : ids.length !== 0)) invalid();
  const selected: Passage[] = [];
  const seen = new Set<string>();
  const counts: Record<Role, number> = { original: 0, revised: 0 };
  for (const id of ids) {
    if (typeof id !== 'string' || seen.has(id)) invalid();
    const source = experiment.allowed.get(id);
    if (!source || passageId(source) !== id || ++counts[source.role] > 4) invalid();
    selected.push(source);
    seen.add(id);
  }
  const canonical = JSON.stringify({
    format: RESULT, version: 1, request_sha256: digest, model: raw.model,
    model_digest: raw.model_digest, selection: { status: selection.status, ids },
    authority_verified: false,
  }, null, 2) + '\n';
  if (canonical !== text) invalid();
  return {
    model: raw.model, digest: raw.model_digest, status: selection.status, selected,
    omittedBaseline: experiment.baseline.filter(passage => !seen.has(passageId(passage))),
  };
}
