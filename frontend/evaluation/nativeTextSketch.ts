/** Deterministic bounded word-shingle sketches for private duplicate review.
 * Approximate lexical overlap, not semantic equivalence or a security hash.
 * The bottom-k sample of a union can be reconstructed from the two bottom-k
 * sketches: a hash in the union's bottom-k must occur in each member's
 * bottom-k if present there. Equal complete sketches yield exact sampled
 * overlap (still subject to hash collisions).
 */
import { createHash } from 'node:crypto';
import type { Passage } from '../src/pdfChatCore';

export const SHINGLE_WORDS = 5;
export const SKETCH_SIZE = 1024;
export const MAX_SOURCE_TOKENS = 200_000;
export const MAX_DATASET_TOKENS = 4_000_000;
export const MIN_SOURCE_TOKENS = 20;
export const MIN_OVERLAP_SAMPLE = 16;
export type NativeSketch = {
  tokens: number;
  normalizedSha256: string;
  hashes: number[];
  truncated: boolean;
};
export type SketchOverlap = {
  unionSample: number;
  sharedSample: number;
  jaccard: number | null;
  sampled: boolean;
};
function invalid(): never { throw new Error('Invalid or oversized native text sketch.'); }
export function* normalizedTokens(text: string): Generator<string> {
  const normalized = text.normalize('NFKC').toLowerCase();
  for (const match of normalized.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) yield match[0];
}
/** Two independently mixed 32-bit streams combined as an exactly
 * representable 53-bit integer. These are not cryptographic fingerprints.
 */
function tokenHash(word: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < word.length; i++) {
    hash ^= word.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
    hash ^= hash >>> 13;
  }
  hash ^= hash >>> 16;
  return hash >>> 0;
}
function shingleHash(window: { a: number; b: number }[]): number {
  let a = 0x85ebca6b, b = 0xc2b2ae35;
  for (const word of window) {
    a = Math.imul(a ^ word.a, 0x27d4eb2d);
    b = Math.imul(b ^ word.b, 0x165667b1);
    a ^= a >>> 15;
    b ^= b >>> 13;
  }
  return (a >>> 0) * 0x200000 + (b >>> 11);
}
/** Fixed-size maximum heap. It stores only distinct retained hashes.
 * Once the heap is full its maximum can only decrease, so rejected
 * larger values can never become eligible later.
 */
class BottomK {
  private values: number[] = [];
  private retained = new Set<number>();
  truncated = false;
  constructor(private readonly limit: number) {}
  private swap(a: number, b: number) {
    [this.values[a], this.values[b]] = [this.values[b], this.values[a]];
  }
  private up(index: number) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent] >= this.values[index]) break;
      this.swap(parent, index); index = parent;
    }
  }
  private down(index: number) {
    for (;;) {
      const left = 2 * index + 1, right = left + 1;
      let largest = index;
      if (left < this.values.length && this.values[left] > this.values[largest]) largest = left;
      if (right < this.values.length && this.values[right] > this.values[largest]) largest = right;
      if (largest === index) return;
      this.swap(index, largest); index = largest;
    }
  }
  add(value: number) {
    if (!Number.isSafeInteger(value) || value < 0) invalid();
    if (this.retained.has(value)) return;
    if (this.values.length < this.limit) {
      this.retained.add(value);
      this.values.push(value);
      this.up(this.values.length - 1);
      return;
    }
    this.truncated = true;
    if (value >= this.values[0]) return;
    this.retained.delete(this.values[0]);
    this.retained.add(value);
    this.values[0] = value;
    this.down(0);
  }
  sorted(): number[] { return [...this.values].sort((a, b) => a - b); }
}
/** Hash the full normalized token sequence independently of the sketch.
 * Fragment boundaries are ignored so line wrapping alone does not
 * disguise duplicate text. Numeric tokens and their order are preserved.
 */
export function sketchNativeText(passages: readonly Passage[], tokenBudget = MAX_SOURCE_TOKENS): NativeSketch {
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0 || tokenBudget > MAX_SOURCE_TOKENS) invalid();
  const retained = new BottomK(SKETCH_SIZE);
  const digest = createHash('sha256');
  const window: { a: number; b: number }[] = [];
  let tokens = 0;
  for (const source of passages) {
    for (const word of normalizedTokens(source.text)) {
      if (++tokens > tokenBudget) invalid();
      // Tokens contain no NUL; this separator makes the sequence unambiguous.
      digest.update(word, 'utf8').update('\0');
      window.push({ a: tokenHash(word, 2166136261), b: tokenHash(word, 0x9e3779b9) });
      if (window.length === SHINGLE_WORDS) {
        retained.add(shingleHash(window));
        window.shift();
      }
    }
  }
  return { tokens, normalizedSha256: digest.digest('hex'), hashes: retained.sorted(), truncated: retained.truncated };
}
function validateSketch(sketch: NativeSketch) {
  if (!Number.isSafeInteger(sketch.tokens) || sketch.tokens < 0 || sketch.tokens > MAX_SOURCE_TOKENS ||
      !/^[a-f0-9]{64}$/.test(sketch.normalizedSha256) || !Array.isArray(sketch.hashes) ||
      sketch.hashes.length > SKETCH_SIZE || sketch.hashes.length > Math.max(0, sketch.tokens - SHINGLE_WORDS + 1) ||
      typeof sketch.truncated !== 'boolean' || (sketch.truncated && sketch.hashes.length !== SKETCH_SIZE) ||
      sketch.hashes.some((hash, i) => !Number.isSafeInteger(hash) || hash < 0 || (i > 0 && hash <= sketch.hashes[i - 1]))) invalid();
}
export function compareNativeSketches(left: NativeSketch, right: NativeSketch): SketchOverlap {
  validateSketch(left); validateSketch(right);
  let a = 0, b = 0, unionSample = 0, sharedSample = 0;
  while (unionSample < SKETCH_SIZE && (a < left.hashes.length || b < right.hashes.length)) {
    const first = left.hashes[a] ?? Infinity, second = right.hashes[b] ?? Infinity;
    if (first === second) { sharedSample++; a++; b++; }
    else if (first < second) a++;
    else b++;
    unionSample++;
  }
  return { unionSample, sharedSample, jaccard: unionSample ? sharedSample / unionSample : null,
    sampled: left.truncated || right.truncated || a < left.hashes.length || b < right.hashes.length };
}
