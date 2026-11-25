/** File-based semantic candidate exchange. No browser network model calls. */
import type { Answer, Passage, Role, SearchIndex } from './pdfChatCore';
import { allowedPassages, fuseRanks, passageId } from './pdfChatResearch';

export const MAX_EXPERIMENT_PASSAGES = 512;
export const MAX_EXPERIMENT_BYTES = 2 * 1024 * 1024;
export const MAX_RANK_FILE = 64 * 1024;
const FORMAT = 'noticebridge-chat-embedding-request';
const RESULT = 'noticebridge-chat-embedding-result';
const SHA = /^[a-f0-9]{64}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63})?:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ROLES: Role[] = ['original', 'revised'];

export type Experiment = {
  text: string;
  allowed: ReadonlyMap<string, Passage>;
  baseline: readonly Passage[];
};
export type CandidateReview = {
  model: string;
  digest: string;
  dimension: number;
  candidates: { passage: Passage; ranks: { channel: string; rank: number }[] }[];
};

export function prepareExperiment(index: SearchIndex, answer: Answer): Experiment {
  const roles: Role[] = answer.scope === 'both' ? ROLES : [answer.scope];
  const allowed = allowedPassages(index.rows.map(row => row.passage), roles, answer.pageFilter);
  if (!allowed.size || allowed.size > MAX_EXPERIMENT_PASSAGES) {
    throw new Error('Choose a narrower source or physical page (maximum 512 passages).');
  }
  const passages = [...allowed.entries()].map(([id, source]) => ({ id, text: source.text }));
  const text = JSON.stringify({
    format: FORMAT, version: 1, question: answer.question, passages,
  }, null, 2) + '\n';
  if (new TextEncoder().encode(text).length > MAX_EXPERIMENT_BYTES) {
    throw new Error('Request exceeds the experiment file limit.');
  }
  return { text, allowed, baseline: answer.citations };
}

export async function requestHash(text: string): Promise<string> {
  if (!crypto?.subtle) throw new Error('Request verification requires HTTPS or localhost.');
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(result), n => n.toString(16).padStart(2, '0')).join('');
}

function invalid(): never {
  throw new Error('Invalid or mismatched ranking file.');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length ||
      !keys.every(key => Object.prototype.hasOwnProperty.call(value, key))) invalid();
}

export function reviewRanking(text: string, experiment: Experiment, digest: string): CandidateReview {
  if (!text || text.length > MAX_RANK_FILE || new TextEncoder().encode(text).length > MAX_RANK_FILE) invalid();
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid(); }
  const raw = object(value);
  exact(raw, ['format', 'version', 'request_sha256', 'model', 'model_digest', 'dimension',
    'candidate_count', 'ranks', 'authority_verified']);
  if (raw.format !== RESULT || raw.version !== 1 || !SHA.test(digest) ||
      raw.request_sha256 !== digest || raw.candidate_count !== experiment.allowed.size ||
      raw.authority_verified !== false || typeof raw.model !== 'string' ||
      raw.model.length > 96 || !MODEL.test(raw.model) || /cloud/i.test(raw.model) ||
      typeof raw.model_digest !== 'string' || !SHA.test(raw.model_digest) ||
      typeof raw.dimension !== 'number' || !Number.isInteger(raw.dimension) ||
      raw.dimension < 1 || raw.dimension > 2048) invalid();
  const ranks = object(raw.ranks);
  const expectedRoles = ROLES.filter(role => [...experiment.allowed.values()].some(p => p.role === role));
  exact(ranks, expectedRoles);
  const canonicalRanks: Partial<Record<Role, string[]>> = {};
  const candidates: CandidateReview['candidates'] = [];
  for (const role of expectedRoles) {
    const allowed = new Map([...experiment.allowed].filter(([, passage]) => passage.role === role));
    const ids = ranks[role];
    if (!Array.isArray(ids) || ids.length !== Math.min(8, allowed.size) ||
        ids.some(id => typeof id !== 'string' || !allowed.has(id)) || new Set(ids).size !== ids.length) invalid();
    canonicalRanks[role] = ids;
    const baseline = experiment.baseline.filter(p => p.role === role).map(passageId);
    // No model can remove a baseline citation: this panel only supplements
    // the unchanged chat answer and never imports model-supplied text.
    const fused = fuseRanks(allowed, [
      { name: 'baseline', ids: [...new Set(baseline)] },
      { name: 'dense', ids },
    ], 8);
    for (const row of fused) candidates.push({ passage: allowed.get(row.id)!, ranks: row.ranks });
  }
  // Canonical cross-language JSON (ASCII metadata only) rejects duplicate
  // keys, whitespace variants and unknown fields. Python CLI writes this form.
  const canonical = JSON.stringify({
    format: RESULT, version: 1, request_sha256: digest, model: raw.model,
    model_digest: raw.model_digest, dimension: raw.dimension,
    candidate_count: experiment.allowed.size, ranks: canonicalRanks, authority_verified: false,
  }, null, 2) + '\n';
  if (canonical !== text) invalid();
  return { model: raw.model, digest: raw.model_digest, dimension: raw.dimension, candidates };
}
