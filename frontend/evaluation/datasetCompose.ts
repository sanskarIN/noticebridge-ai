/** Compose independently prepared manifests without rewriting labels or splitting families. */
import { parseDataset, loadDataset, MAX_DATASET_DOCUMENTS, MAX_DATASET_CASES,
  type Dataset, type DatasetArtifact, type DocumentLabels } from './retrievalDataset';
import type { RetrievalCase } from './retrievalMetrics';

export const MAX_INPUT_MANIFESTS = 40;
export type NamedManifest = { name: string; text: string; sha256: string };
export type Composition = {
  manifest: string;
  audit: {
    dataset: string; kind: Dataset['kind'];
    inputs: { name: string; sha256: string; documents: number; cases: number }[];
    documents: number; cases: number; families: number;
    development: { documents: number; cases: number; families: number };
    holdout: { documents: number; cases: number; families: number };
    authority_verified: false;
  };
};
const SHA = /^[a-f0-9]{64}$/;
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FILE = /^[a-z0-9][a-z0-9_-]{0,63}\.json$/;
function invalid(): never { throw new Error('Invalid or conflicting dataset composition.'); }

function wireCase(row: RetrievalCase) {
  return { id: row.id, slices: [...row.slices], question: row.question, scope: row.scope,
    ...(row.page === undefined ? {} : { page: row.page }), label: row.label.kind === 'answerable'
      ? { kind: row.label.kind, evidenceSets: row.label.evidenceSets.map(ids => [...ids]) }
      : { kind: row.label.kind } };
}
function wireDocument(row: DocumentLabels) {
  return { id: row.id, family: row.family, split: row.split, snapshot: row.snapshot,
    snapshot_sha256: row.snapshot_sha256, cases: row.cases.map(wireCase) };
}
function counts(documents: DocumentLabels[]) {
  return { documents: documents.length, cases: documents.reduce((n, row) => n + row.cases.length, 0),
    families: new Set(documents.map(row => row.family)).size };
}
/** No promotion of mixed synthetic and independently reviewed labels.
 * Reject duplicate identities instead of renumbering references silently.
 * Inputs and all referenced snapshots must be explicitly supplied.
 */
export function composeDataset(id: string, inputs: NamedManifest[], artifacts: DatasetArtifact[]): Composition {
  if (!NAME.test(id) || !Array.isArray(inputs) || !inputs.length || inputs.length > MAX_INPUT_MANIFESTS) invalid();
  const inputNames = new Set<string>(), inputDigests = new Set<string>();
  const seenDocs = new Set<string>(), seenCases = new Set<string>(), seenFiles = new Set<string>();
  const splitByFamily = new Map<string, DocumentLabels['split']>();
  let kind: Dataset['kind'] | undefined;
  const documents: DocumentLabels[] = [];
  const auditInputs: Composition['audit']['inputs'] = [];
  for (const input of inputs) {
    if (!FILE.test(input.name) || !SHA.test(input.sha256) ||
        inputNames.has(input.name) || inputDigests.has(input.sha256)) invalid();
    inputNames.add(input.name); inputDigests.add(input.sha256);
    const dataset = parseDataset(input.text);
    if (kind !== undefined && kind !== dataset.kind) invalid();
    kind = dataset.kind;
    auditInputs.push({ name: input.name, sha256: input.sha256,
      documents: dataset.documents.length, cases: counts(dataset.documents).cases });
    for (const row of dataset.documents) {
      if (seenDocs.has(row.id) || seenFiles.has(row.snapshot) || inputNames.has(row.snapshot) ||
          (splitByFamily.has(row.family) && splitByFamily.get(row.family) !== row.split)) invalid();
      seenDocs.add(row.id); seenFiles.add(row.snapshot); splitByFamily.set(row.family, row.split);
      for (const item of row.cases) {
        if (seenCases.has(item.id)) invalid();
        seenCases.add(item.id);
      }
      if (seenDocs.size > MAX_DATASET_DOCUMENTS || seenCases.size > MAX_DATASET_CASES) invalid();
      documents.push(row);
    }
  }
  if ([...inputNames].some(name => seenFiles.has(name))) invalid();
  const sorted = [...documents].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const manifest = JSON.stringify({ format: 'noticebridge-retrieval-labels', version: 1,
    id, kind, documents: sorted.map(wireDocument) }, null, 2) + '\n';
  // Final global validation catches shared PDF hashes across different
  // family assignments, scope errors and stale snapshot bindings.
  const composed = parseDataset(manifest);
  loadDataset(composed, artifacts);
  return { manifest, audit: {
    dataset: id, kind: composed.kind,
    inputs: auditInputs.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    ...counts(sorted),
    development: counts(sorted.filter(row => row.split === 'development')),
    holdout: counts(sorted.filter(row => row.split === 'holdout')),
    authority_verified: false,
  } };
}
