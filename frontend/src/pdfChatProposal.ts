/** Research-only extractive model protocol. Never certifies entailment. */
import type { Passage } from './pdfChatCore';
import { passageId, MAX_RANKED } from './pdfChatResearch';

export const MAX_PROPOSAL_SPANS = 8;
export const MAX_SPAN_CHARS = 300;
export const MAX_PROPOSAL_BYTES = 16 * 1024;
const MAX_DEPTH = 8;

export type ProposedSpan = { id: string; start: number; end: number; text: string; source: Passage };
export type ExtractiveProposal =
  | { status: 'insufficient'; spans: [] }
  | { status: 'extract'; spans: ProposedSpan[] };

function fail(): never {
  throw new Error('Invalid extractive proposal.');
}
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length ||
      !keys.every(key => Object.prototype.hasOwnProperty.call(raw, key))) fail();
  return raw;
}

/** A bounded scanner for JSON depth and duplicate object member names.
 * JSON.parse then checks the full grammar. Decoded key equality catches
 * escaped duplicates, including escaped surrogate pairs.
 */
function preflight(text: string): void {
  if (!text || text.length > MAX_PROPOSAL_BYTES ||
      new TextEncoder().encode(text).length > MAX_PROPOSAL_BYTES) fail();
  const stack: { kind: '{' | '['; keys: Set<string> }[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '{' || char === '[') {
      stack.push({ kind: char, keys: new Set() });
      if (stack.length > MAX_DEPTH) fail();
      i++;
    } else if (char === '}' || char === ']') {
      const frame = stack.pop();
      if (!frame || (char === '}' ? frame.kind !== '{' : frame.kind !== '[')) fail();
      i++;
    } else if (char === '"') {
      const start = i++;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i++] === '"') { closed = true; break; }
      }
      if (!closed) fail();
      let next = i;
      while (next < text.length && /[ \t\r\n]/.test(text[next])) next++;
      if (text[next] === ':') {
        const frame = stack.at(-1);
        if (!frame || frame.kind !== '{') fail();
        let key: unknown;
        try { key = JSON.parse(text.slice(start, i)); } catch { return fail(); }
        if (typeof key !== 'string' || frame.keys.has(key)) fail();
        frame.keys.add(key);
      }
    } else i++;
  }
  if (stack.length) fail();
}

function splitsSurrogate(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** The allowed map is constructed locally from the exact candidate set.
 * Model output supplies only candidate IDs and UTF-16 offsets.
 * Return original substrings, not any model-supplied text or metadata.
 */
export function validateExtractiveProposal(
  rawText: string, allowed: ReadonlyMap<string, Passage>,
): ExtractiveProposal {
  if (allowed.size > MAX_RANKED) fail();
  preflight(rawText);
  let decoded: unknown;
  try { decoded = JSON.parse(rawText); } catch { return fail(); }
  const raw = object(decoded, ['status', 'spans']);
  if (!Array.isArray(raw.spans) || raw.spans.length > MAX_PROPOSAL_SPANS) fail();
  if (raw.status === 'insufficient') {
    if (raw.spans.length) fail();
    return { status: 'insufficient', spans: [] };
  }
  if (raw.status !== 'extract' || !raw.spans.length) fail();
  const spans: ProposedSpan[] = [];
  for (const item of raw.spans) {
    const row = object(item, ['id', 'start', 'end']);
    if (typeof row.id !== 'string' || typeof row.start !== 'number' || typeof row.end !== 'number' ||
        !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end)) fail();
    const source = allowed.get(row.id);
    if (!source || passageId(source) !== row.id ||
        row.start < 0 || row.end > source.text.length || row.end <= row.start ||
        row.end - row.start > MAX_SPAN_CHARS ||
        splitsSurrogate(source.text, row.start) || splitsSurrogate(source.text, row.end)) fail();
    const text = source.text.slice(row.start, row.end);
    if (!text.trim()) fail();
    const start = row.start, end = row.end;
    if (spans.some(span => span.id === row.id && start < span.end && end > span.start)) fail();
    spans.push({ id: row.id, start, end, text, source });
  }
  return { status: 'extract', spans };
}
