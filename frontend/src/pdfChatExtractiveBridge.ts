/** Strict, request-bound import for local model extractive proposals. */
import type { Passage, Role } from './pdfChatCore';
import { validateExtractiveProposal, type ExtractiveProposal } from './pdfChatProposal';
import { passageId } from './pdfChatResearch';
import type { SelectionExperiment } from './pdfChatSelectionBridge';

export const MAX_EXTRACTIVE_RESULT_BYTES = 32 * 1024;
const FORMAT = 'noticebridge-chat-extractive-result';
const SHA = /^[a-f0-9]{64}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63})?:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export type ExtractiveReview = {
  model: string;
  digest: string;
  proposal: ExtractiveProposal;
  omittedBaseline: Passage[];
  missingRoles: Role[];
};

function fail(): never { throw new Error('Invalid or mismatched extractive proposal.'); }

export function reviewExtractive(
  text: string, experiment: SelectionExperiment, digest: string,
): ExtractiveReview {
  if (!text || text.length > MAX_EXTRACTIVE_RESULT_BYTES ||
      new TextEncoder().encode(text).length > MAX_EXTRACTIVE_RESULT_BYTES) fail();
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { return fail(); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) fail();
  const raw = decoded as Record<string, unknown>;
  if (raw.format !== FORMAT || raw.version !== 1 ||
      !SHA.test(digest) || raw.request_sha256 !== digest ||
      raw.authority_verified !== false ||
      typeof raw.model !== 'string' || raw.model.length > 96 || !MODEL.test(raw.model) ||
      /cloud/i.test(raw.model) || typeof raw.model_digest !== 'string' ||
      !SHA.test(raw.model_digest)) fail();
  // The existing independent span validator reconstructs original text,
  // rejects unknown IDs, invalid UTF-16 offsets, overlap and schema extras.
  const proposal = validateExtractiveProposal(JSON.stringify(raw.proposal) ?? '', experiment.allowed);
  const counts: Record<Role, number> = { original: 0, revised: 0 };
  const selected = new Set<string>();
  for (const span of proposal.spans) {
    if (++counts[span.source.role] > 4 || span.text !== span.text.trim() ||
        span.source.text.indexOf(span.text) !== span.start ||
        span.source.text.indexOf(span.text, span.start + 1) !== -1) fail();
    selected.add(span.id);
  }
  // Canonicalize nested span fields too, so decoded duplicates or a
  // different wire ordering cannot pass by changing only the outer shape.
  const canonical = JSON.stringify({
    format: FORMAT, version: 1, request_sha256: digest,
    model: raw.model, model_digest: raw.model_digest,
    proposal: { status: proposal.status, spans: proposal.spans.map(span => ({
      id: span.id, start: span.start, end: span.end,
    })) },
    authority_verified: false,
  }, null, 2) + '\n';
  if (canonical !== text) fail();
  const roles = new Set([...experiment.allowed.values()].map(source => source.role));
  return {
    model: raw.model, digest: raw.model_digest, proposal,
    omittedBaseline: experiment.baseline.filter(source => !selected.has(passageId(source))),
    missingRoles: [...roles].filter(role => !counts[role]),
  };
}
