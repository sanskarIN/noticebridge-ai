/** Research-only retrieval primitives. No model calls or UI integration. */
import type { Passage, Role } from './pdfChatCore';

export const MAX_RANKED = 128;
export const MAX_DIMENSION = 2048;
export const MAX_VECTORS = 12000;
const MAX_CHANNELS = 4;

export function passageId(passage: Passage): string {
  if ((passage.role !== 'original' && passage.role !== 'revised') ||
      !Number.isSafeInteger(passage.page) || passage.page < 1 || passage.page > 80 ||
      !Number.isSafeInteger(passage.ordinal) || passage.ordinal < 1) {
    throw new Error('Invalid passage identity.');
  }
  return passage.role + ':' + passage.page + ':' + passage.ordinal;
}

export function allowedPassages(
  passages: readonly Passage[], roles: readonly Role[], page?: number,
): Map<string, Passage> {
  if (!roles.length || roles.length > 2 || roles.some(role => role !== 'original' && role !== 'revised') ||
      new Set(roles).size !== roles.length || passages.length > MAX_VECTORS ||
      (page !== undefined && (!Number.isSafeInteger(page) || page < 1 || page > 80))) {
    throw new Error('Invalid candidate scope.');
  }
  const result = new Map<string, Passage>();
  for (const passage of passages) {
    const id = passageId(passage);
    if (!roles.includes(passage.role) || (page !== undefined && passage.page !== page)) continue;
    if (result.has(id)) throw new Error('Duplicate passage identity.');
    result.set(id, passage);
  }
  return result;
}

export type RankChannel = { name: string; ids: readonly string[] };
export type FusedCandidate = { id: string; score: number; ranks: { channel: string; rank: number }[] };

/** RRF combines rank orders, not raw incompatible relevance scores. */
export function fuseRanks(
  allowed: ReadonlyMap<string, Passage>, channels: readonly RankChannel[], limit = 16, k = 60,
): FusedCandidate[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RANKED ||
      !Number.isFinite(k) || k < 1 || k > 1000 ||
      channels.length > MAX_CHANNELS || allowed.size > MAX_VECTORS) {
    throw new Error('Invalid fusion budget.');
  }
  const names = new Set<string>();
  const scores = new Map<string, FusedCandidate>();
  for (const channel of channels) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(channel.name) || names.has(channel.name) ||
        channel.ids.length > MAX_RANKED) throw new Error('Invalid rank channel.');
    names.add(channel.name);
    const seen = new Set<string>();
    for (const [i, id] of channel.ids.entries()) {
      if (!allowed.has(id) || seen.has(id)) throw new Error('Unknown or repeated candidate.');
      seen.add(id);
      const rank = i + 1;
      let candidate = scores.get(id);
      if (!candidate) {
        candidate = { id, score: 0, ranks: [] };
        scores.set(id, candidate);
      }
      candidate.ranks.push({ channel: channel.name, rank });
      candidate.score += 1 / (k + rank);
    }
  }
  // Use an explicit numeric source order to make ties reproducible.
  return [...scores.values()].sort((a, b) => {
    const x = allowed.get(a.id)!;
    const y = allowed.get(b.id)!;
    return b.score - a.score || (x.role === y.role ? 0 : x.role === 'original' ? -1 : 1)
      || x.page - y.page || x.ordinal - y.ordinal;
  }).slice(0, limit);
}

/** Normalize finite nonzero vectors without overflow from squared values. */
export function unitVector(input: readonly number[], dimension: number): Float32Array {
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > MAX_DIMENSION ||
      input.length !== dimension) throw new Error('Invalid vector dimensions.');
  let scale = 0;
  for (const value of input) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid vector value.');
    scale = Math.max(scale, Math.abs(value));
  }
  if (scale === 0) throw new Error('Zero vector.');
  let squares = 0;
  for (const value of input) squares += (value / scale) ** 2;
  const norm = Math.sqrt(squares);
  return Float32Array.from(input, value => (value / scale) / norm);
}

export type VectorRow = { id: string; values: readonly number[] };
/** Exact small-corpus baseline, not an ANN index or a trained embedding model. */
export function cosineRank(
  allowed: ReadonlyMap<string, Passage>, query: readonly number[],
  rows: readonly VectorRow[], limit = 16,
): { id: string; similarity: number }[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RANKED ||
      rows.length > MAX_VECTORS || allowed.size > MAX_VECTORS) {
    throw new Error('Invalid vector budget.');
  }
  const q = unitVector(query, query.length);
  const seen = new Set<string>();
  const scores = rows.map(row => {
    if (!allowed.has(row.id) || seen.has(row.id)) throw new Error('Unknown or repeated vector identity.');
    seen.add(row.id);
    const vector = unitVector(row.values, q.length);
    let similarity = 0;
    for (let i = 0; i < q.length; i++) similarity += q[i] * vector[i];
    return { id: row.id, similarity: Math.max(-1, Math.min(1, similarity)) };
  });
  return scores.sort((a, b) => {
    const x = allowed.get(a.id)!;
    const y = allowed.get(b.id)!;
    return b.similarity - a.similarity || (x.role === y.role ? 0 : x.role === 'original' ? -1 : 1)
      || x.page - y.page || x.ordinal - y.ordinal;
  }).slice(0, limit);
}
