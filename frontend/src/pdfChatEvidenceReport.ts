/** Private, replay-verifiable snapshots of deterministic chat evidence.
 * Never imports stored answers into the conversation or establishes authority. */
import { type Answer, type Corpus, type Passage, type Role, type SearchIndex } from './pdfChatCore';
import { parseQuestionPlan, replayQuestions, serializeQuestionPlan, stepsFromTurns,
  type ChatTurn, type SourcePins } from './pdfChatSession';

export const MAX_EVIDENCE_REPORT_BYTES = 4 * 1024 * 1024;
const FORMAT = 'noticebridge-pdf-chat-evidence-report';
const POLICY = 'Deterministic indexed evidence only; not an official or independently verified answer.';
const ROLES: Role[] = ['original', 'revised'];
export type ChatCorpora = Partial<Record<Role, Corpus>>;
export type EvidenceReplaySummary = {
  turns: number;
  questions: number;
  citations: number;
  insufficient: number;
};

export class EvidenceReportError extends Error {
  constructor(readonly code: 'invalid' | 'size' | 'mismatch') {
    super(code);
  }
}

function fail(code: EvidenceReportError['code'] = 'invalid'): never {
  throw new EvidenceReportError(code);
}

function bound(text: string): void {
  if (!text || text.length > MAX_EVIDENCE_REPORT_BYTES ||
      new TextEncoder().encode(text).length > MAX_EVIDENCE_REPORT_BYTES) fail('size');
}

function quote(passage: Passage) {
  // Persist text and physical identity, not optional layout metadata:
  // the browser does not certify highlight coordinates.
  return { role: passage.role, page: passage.page, ordinal: passage.ordinal, text: passage.text };
}

function answerSnapshot(answer: Answer) {
  return {
    question: answer.question,
    scope: answer.scope,
    page: answer.pageFilter ?? null,
    kind: answer.kind,
    citations: answer.citations.map(quote),
    missing_roles: [...answer.missingRoles],
    matched_counts: { original: answer.matchedCounts.original, revised: answer.matchedCounts.revised },
    context_groups: answer.contextGroups.map(group => ({
      role: group.role, page: group.page, citations: [...group.citations],
    })),
    printed_fields: answer.printedFields.map(field => ({
      citation: field.citation, label: field.label, value: field.value,
    })),
  };
}

function coverageSnapshot(pins: SourcePins, corpora: ChatCorpora) {
  const output = ROLES.flatMap(role => {
    const corpus = corpora[role];
    if (Boolean(corpus) !== Boolean(pins[role])) fail();
    if (!corpus) return [];
    return [{
      role,
      physical_pages: corpus.pageCount,
      processed_pages: corpus.processedPages,
      indexed_fragments: corpus.passages.length,
      missing_pages: [...corpus.missingPages],
      limited_pages: [...corpus.limitedPages],
      limited: corpus.limited,
    }];
  });
  return output;
}

function snapshot(pins: SourcePins, corpora: ChatCorpora, turns: ChatTurn[], plan: string): string {
  const text = JSON.stringify({
    format: FORMAT,
    version: 1,
    policy: POLICY,
    authority_verified: false,
    question_plan: plan,
    source_coverage: coverageSnapshot(pins, corpora),
    turns: turns.map(turn => ({
      resolved: turn.resolved, answers: turn.answers.map(answerSnapshot),
    })),
  }, null, 2) + '\n';
  bound(text);
  return text;
}

/** Recompute before export rather than trusting stale in-memory answer
 * state. An exact mismatch is an error, not permission to replace it.
 */
export function exportEvidenceReport(
  pins: SourcePins, corpora: ChatCorpora, index: SearchIndex, turns: ChatTurn[],
): string {
  const plan = serializeQuestionPlan(pins, stepsFromTurns(turns));
  const steps = parseQuestionPlan(plan, pins);
  const roles = ROLES.filter(role => Boolean(pins[role]));
  const replayed = replayQuestions(index, steps, roles);
  const observed = snapshot(pins, corpora, turns, plan);
  if (observed !== snapshot(pins, corpora, replayed, plan)) fail('mismatch');
  return observed;
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  return input as Record<string, unknown>;
}

/** Only the embedded canonical question plan is consumed as input.
 * All other imported fields are treated as untrusted bytes and must match
 * a new deterministic replay exactly. No imported citation is rendered.
 */
export function verifyEvidenceReport(
  text: string, pins: SourcePins, corpora: ChatCorpora, index: SearchIndex,
): EvidenceReplaySummary {
  bound(text);
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { return fail(); }
  const raw = object(decoded);
  if (raw.format !== FORMAT || raw.version !== 1 || raw.policy !== POLICY ||
      raw.authority_verified !== false || typeof raw.question_plan !== 'string') fail();
  const steps = parseQuestionPlan(raw.question_plan, pins);
  const replayed = replayQuestions(index, steps, ROLES.filter(role => Boolean(pins[role])));
  // Byte equality rejects additional fields, reordered keys, duplicate
  // members, fabricated quotes, altered page IDs and stale coverage.
  if (text !== snapshot(pins, corpora, replayed, raw.question_plan)) fail('mismatch');
  const answers = replayed.flatMap(turn => turn.answers);
  return {
    turns: replayed.length,
    questions: answers.length,
    citations: answers.reduce((count, answer) => count + answer.citations.length, 0),
    insufficient: answers.filter(answer => answer.kind === 'insufficient').length,
  };
}

export async function readEvidenceReport(file: File): Promise<string> {
  if (!file.size || file.size > MAX_EVIDENCE_REPORT_BYTES) fail('size');
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size || bytes.byteLength > MAX_EVIDENCE_REPORT_BYTES) fail('size');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail(); }
  bound(text);
  return text;
}
