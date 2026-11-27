/** Reconcile two complete independent review passes with an explicitly
 * authored third pass covering exactly their disagreements.
 *
 * This is a source-bound research artifact, not a vote, automatic ground
 * truth generator, or proof of reviewer identity. No model is called.
 */
import { createHash } from 'node:crypto';
import { compareAnnotations, type AdjudicationTask } from './annotationAgreement';
import { parseDataset, loadDataset, MAX_MANIFEST_BYTES,
  type Dataset, type DatasetArtifact, type DocumentLabels } from './retrievalDataset';
import type { Label, RetrievalCase } from './retrievalMetrics';

export type ReviewInput = { manifest: string; artifacts: DatasetArtifact[] };
export type ResolutionSource = 'agreement' | 'third_review';
export type ResolutionReason = 'exact_agreement' | AdjudicationTask['reason'];
export type ResolutionEntry = {
  id: string;
  document: string;
  family: string;
  split: DocumentLabels['split'];
  source: ResolutionSource;
  reason: ResolutionReason;
  kind: Label['kind'];
  alternative_count: number;
};
export type ReconciliationAudit = {
  format: 'noticebridge-annotation-reconciliation';
  version: 1;
  dataset: string;
  label_kind: Dataset['kind'];
  authority_verified: false;
  reviewer_identity_verified: false;
  policy: string;
  inputs: { left_sha256: string; right_sha256: string; third_sha256: string | null };
  manifest_sha256: string;
  documents: number;
  families: number;
  cases: number;
  agreed: number;
  third_reviewed: number;
  by_split: { split: DocumentLabels['split']; cases: number; agreed: number; third_reviewed: number }[];
  resolutions: ResolutionEntry[];
};
export type Reconciliation = { manifest: string; audit: ReconciliationAudit };
type ValidatedSide = { dataset: Dataset; artifacts: DatasetArtifact[]; digest: string };
type Located = { document: DocumentLabels; row: RetrievalCase };
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const POLICY = 'Exact metadata agreement and declared human adjudication only; not proof of source authenticity, reviewer independence or label correctness.';

function fail(): never {
  throw new Error('Incomplete or incomparable annotation reconciliation.');
}
function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
function encode(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}
function lexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function sorted(values: readonly string[]): string[] {
  return [...values].sort(lexical);
}

/** The shared dataset loader recomputes actual snapshot hashes; the input
 * manifest's own byte digest is recorded independently here. */
function validate(input: ReviewInput): ValidatedSide {
  const dataset = parseDataset(input.manifest);
  loadDataset(dataset, input.artifacts);
  return { dataset, artifacts: input.artifacts, digest: sha(input.manifest) };
}
function locate(dataset: Dataset): Map<string, Located> {
  const result = new Map<string, Located>();
  for (const document of dataset.documents) {
    for (const row of document.cases) {
      if (result.has(row.id)) fail();
      result.set(row.id, { document, row });
    }
  }
  return result;
}
function sameMetadata(a: Located, b: Located): boolean {
  return a.document.id === b.document.id &&
    a.document.family === b.document.family &&
    a.document.split === b.document.split &&
    a.document.snapshot_sha256 === b.document.snapshot_sha256 &&
    a.row.id === b.row.id && a.row.family === b.row.family &&
    a.row.question === b.row.question && a.row.scope === b.row.scope &&
    a.row.page === b.row.page &&
    JSON.stringify(sorted(a.row.slices)) === JSON.stringify(sorted(b.row.slices));
}
function canonicalLabel(label: Label): Label {
  if (label.kind !== 'answerable') return { kind: label.kind };
  return { kind: 'answerable',
    evidenceSets: label.evidenceSets.map(set => sorted(set))
      .sort((a, b) => lexical(a.join('|'), b.join('|'))) };
}
function wireCase(row: RetrievalCase, label: Label) {
  return { id: row.id, slices: sorted(row.slices), question: row.question,
    scope: row.scope, ...(row.page === undefined ? {} : { page: row.page }),
    label: canonicalLabel(label) };
}
function splitCounts(rows: ResolutionEntry[], split: DocumentLabels['split']) {
  const selected = rows.filter(row => row.split === split);
  return { split, cases: selected.length,
    agreed: selected.filter(row => row.source === 'agreement').length,
    third_reviewed: selected.filter(row => row.source === 'third_review').length };
}

/** Require both reviewers to cover precisely the same case universe. Missing
 * labels are incomplete review work, never negative examples. Every category
 * or complete-alternative disagreement needs a fresh third human label.
 * The third reviewer may choose new evidence or a different category after
 * inspecting the PDF; no union, majority vote or automated resolution occurs.
 *
 * Output keeps the left snapshot filenames and is usable alongside those
 * exact snapshots. The final global validator runs before publication.
 */
export function reconcileAnnotations(id: string, leftInput: ReviewInput,
  rightInput: ReviewInput, thirdInput?: ReviewInput): Reconciliation {
  if (!ID.test(id)) fail();
  const left = validate(leftInput), right = validate(rightInput);
  if (left.dataset.id === right.dataset.id || left.digest === right.digest ||
      id === left.dataset.id || id === right.dataset.id) fail();
  const agreement = compareAnnotations(left, right);
  if (!agreement.completePairing || agreement.unpaired.length) fail();
  const tasks = new Map(agreement.adjudicationQueue.map(task => [task.id, task]));
  if (tasks.size !== agreement.summary.needsAdjudication ||
      [...tasks.values()].some(task => !task.left || !task.right)) fail();

  let third: ValidatedSide | undefined;
  let thirdCases = new Map<string, Located>();
  if (tasks.size) {
    if (!thirdInput) fail();
    third = validate(thirdInput);
    if (third.dataset.kind !== left.dataset.kind ||
        [id, left.dataset.id, right.dataset.id].includes(third.dataset.id) ||
        [left.digest, right.digest].includes(third.digest)) fail();
    thirdCases = locate(third.dataset);
    if (thirdCases.size !== tasks.size ||
        [...thirdCases.keys()].some(key => !tasks.has(key))) fail();
  } else if (thirdInput) {
    // Refuse unrelated third labels, even when the first two passes agree.
    fail();
  }

  const firstCases = locate(left.dataset);
  const secondCases = locate(right.dataset);
  const resolutions: ResolutionEntry[] = [];
  const documents = [...left.dataset.documents].sort((a, b) => lexical(a.id, b.id)).map(document => ({
    id: document.id, family: document.family, split: document.split,
    snapshot: document.snapshot, snapshot_sha256: document.snapshot_sha256,
    cases: [...document.cases].sort((a, b) => lexical(a.id, b.id)).map(row => {
      const first = firstCases.get(row.id), second = secondCases.get(row.id);
      if (!first || !second || !sameMetadata(first, second)) fail();
      const task = tasks.get(row.id);
      const decision = thirdCases.get(row.id);
      if (Boolean(task) !== Boolean(decision) || (decision && !sameMetadata(first, decision))) fail();
      const label = canonicalLabel(decision ? decision.row.label : row.label);
      resolutions.push({ id: row.id, document: document.id, family: document.family,
        split: document.split, source: decision ? 'third_review' : 'agreement',
        reason: task ? task.reason : 'exact_agreement', kind: label.kind,
        alternative_count: label.kind === 'answerable' ? label.evidenceSets.length : 0 });
      return wireCase(row, label);
    }),
  }));
  const manifest = encode({ format: 'noticebridge-retrieval-labels', version: 1,
    id, kind: left.dataset.kind, documents });
  if (Buffer.byteLength(manifest, 'utf8') > MAX_MANIFEST_BYTES) fail();
  const reconciled = parseDataset(manifest);
  loadDataset(reconciled, left.artifacts);
  if (resolutions.length !== firstCases.size ||
      resolutions.filter(row => row.source === 'third_review').length !== tasks.size) fail();
  return { manifest, audit: {
    format: 'noticebridge-annotation-reconciliation', version: 1,
    dataset: id, label_kind: reconciled.kind, authority_verified: false,
    reviewer_identity_verified: false, policy: POLICY,
    inputs: { left_sha256: left.digest, right_sha256: right.digest, third_sha256: third?.digest ?? null },
    manifest_sha256: sha(manifest), documents: documents.length,
    families: new Set(documents.map(document => document.family)).size,
    cases: resolutions.length, agreed: resolutions.length - tasks.size,
    third_reviewed: tasks.size,
    by_split: (['development', 'holdout'] as const).map(split => splitCounts(resolutions, split)),
    resolutions,
  } };
}

/** Exact deterministic replay: a candidate manifest with changed labels,
 * whitespace, metadata or output identity cannot pass as the generated file. */
export function replayReconciliation(candidate: string, id: string,
  left: ReviewInput, right: ReviewInput, third?: ReviewInput): ReconciliationAudit {
  const result = reconcileAnnotations(id, left, right, third);
  if (candidate !== result.manifest) fail();
  return result.audit;
}
