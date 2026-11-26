/** Compare two human-authored annotation manifests without adjudicating them.
 *
 * Both sides must use the same exact native snapshot bytes, document family,
 * question, scope, page and slice metadata for every paired case. Agreement
 * is descriptive and does not establish that either reviewer is correct.
 */
import { loadDataset, type Dataset, type DatasetArtifact, type DocumentLabels } from './retrievalDataset';
import type { Label, RetrievalCase } from './retrievalMetrics';

export const MAX_AGREEMENT_OUTPUT_BYTES = 16 * 1024 * 1024;
const KINDS = ['answerable', 'unanswerable', 'unindexed', 'ambiguous'] as const;
type Kind = typeof KINDS[number];
export type Confusion = Record<Kind, Record<Kind, number>>;
export type EvidenceAgreement = {
  exactAlternatives: boolean;
  leftAlternatives: number;
  rightAlternatives: number;
  commonAlternatives: number;
  unionJaccard: number;
  leftBestCoverage: number;
  rightBestCoverage: number;
  leftOnlyIds: string[];
  rightOnlyIds: string[];
};
export type AgreementCase = {
  id: string;
  document: string;
  family: string;
  split: DocumentLabels['split'];
  slices: string[];
  leftKind: Kind;
  rightKind: Kind;
  sameKind: boolean;
  evidence: EvidenceAgreement | null;
  needsAdjudication: boolean;
};
export type UnpairedCase = {
  id: string;
  document: string;
  family: string;
  split: DocumentLabels['split'];
  side: 'left' | 'right';
};
export type AgreementSummary = {
  pairedCases: number;
  sameKind: number;
  kindAgreement: number | null;
  expectedChanceAgreement: number | null;
  cohenKappa: number | null;
  confusion: Confusion;
  bothAnswerable: number;
  exactAlternativeMatches: number;
  exactAlternativeAgreement: number | null;
  meanUnionJaccard: number | null;
  meanLeftBestCoverage: number | null;
  meanRightBestCoverage: number | null;
  needsAdjudication: number;
};
export type AgreementReport = {
  format: 'noticebridge-annotation-agreement';
  version: 1;
  leftDataset: string;
  rightDataset: string;
  labelKind: Dataset['kind'];
  authority_verified: false;
  policy: string;
  summary: AgreementSummary;
  splits: { split: DocumentLabels['split']; summary: AgreementSummary }[];
  families: { family: string; summary: AgreementSummary }[];
  slices: { slice: string; summary: AgreementSummary }[];
  paired: AgreementCase[];
  unpaired: UnpairedCase[];
  completePairing: boolean;
};
type LocatedCase = { document: DocumentLabels; row: RetrievalCase };
type DatasetSide = { dataset: Dataset; artifacts: DatasetArtifact[] };

function invalid(): never { throw new Error('Annotation manifests are invalid or use incomparable source/question metadata.'); }
function lexical(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function sorted(values: Iterable<string>): string[] { return [...values].sort(lexical); }
function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
function ratio(a: number, b: number): number | null { return b ? a / b : null; }
function intersection(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const value of a) if (b.has(value)) count++;
  return count;
}
function difference(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return sorted([...a].filter(value => !b.has(value)));
}
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const shared = intersection(a, b), union = a.size + b.size - shared;
  return union ? shared / union : 1;
}
type PositiveLabel = Extract<Label, { kind: 'answerable' }>;
function alternatives(label: PositiveLabel): Set<string>[] {
  if (!label.evidenceSets.length || label.evidenceSets.length > 8) invalid();
  const keys = new Set<string>();
  return label.evidenceSets.map(set => {
    const values = new Set(set);
    if (!set.length || set.length > 24 || values.size !== set.length) invalid();
    const key = sorted(values).join('|');
    if (keys.has(key)) invalid();
    keys.add(key);
    return values;
  });
}
function setKey(set: ReadonlySet<string>): string { return sorted(set).join('|'); }
function bestCoverage(from: Set<string>[], to: Set<string>[]): number {
  // Each source alternative contributes one score, with its best
  // counterpart chosen by intersection coverage. This is intentionally
  // directional and distinct from union Jaccard.
  return from.reduce((total, set) =>
    total + Math.max(...to.map(other => intersection(set, other) / set.size)), 0) / from.length;
}
export function compareEvidenceLabels(left: PositiveLabel, right: PositiveLabel): EvidenceAgreement {
  const a = alternatives(left), b = alternatives(right);
  const leftKeys = new Set(a.map(setKey)), rightKeys = new Set(b.map(setKey));
  const leftUnion = new Set(a.flatMap(set => [...set])), rightUnion = new Set(b.flatMap(set => [...set]));
  const commonAlternatives = intersection(leftKeys, rightKeys);
  return {
    exactAlternatives: commonAlternatives === a.length && commonAlternatives === b.length,
    leftAlternatives: a.length,
    rightAlternatives: b.length,
    commonAlternatives,
    unionJaccard: jaccard(leftUnion, rightUnion),
    leftBestCoverage: bestCoverage(a, b),
    rightBestCoverage: bestCoverage(b, a),
    leftOnlyIds: difference(leftUnion, rightUnion),
    rightOnlyIds: difference(rightUnion, leftUnion),
  };
}
function emptyConfusion(): Confusion {
  return Object.fromEntries(KINDS.map(kind => [kind,
    Object.fromEntries(KINDS.map(other => [other, 0]))])) as Confusion;
}
export function summarizeAgreement(rows: AgreementCase[]): AgreementSummary {
  const confusion = emptyConfusion();
  for (const row of rows) confusion[row.leftKind][row.rightKind]++;
  const count = rows.length;
  const sameKind = KINDS.reduce((sum, kind) => sum + confusion[kind][kind], 0);
  const observed = ratio(sameKind, count);
  const expected = count ? KINDS.reduce((sum, kind) => {
    const left = KINDS.reduce((n, other) => n + confusion[kind][other], 0);
    const right = KINDS.reduce((n, other) => n + confusion[other][kind], 0);
    return sum + left * right;
  }, 0) / (count * count) : null;
  const positives = rows.flatMap(row => row.evidence ? [row.evidence] : []);
  const exact = positives.filter(row => row.exactAlternatives).length;
  return {
    pairedCases: count, sameKind, kindAgreement: observed, expectedChanceAgreement: expected,
    cohenKappa: observed === null || expected === null || expected === 1 ? null : (observed - expected) / (1 - expected),
    confusion,
    bothAnswerable: positives.length, exactAlternativeMatches: exact,
    exactAlternativeAgreement: ratio(exact, positives.length),
    meanUnionJaccard: ratio(positives.reduce((sum, row) => sum + row.unionJaccard, 0), positives.length),
    meanLeftBestCoverage: ratio(positives.reduce((sum, row) => sum + row.leftBestCoverage, 0), positives.length),
    meanRightBestCoverage: ratio(positives.reduce((sum, row) => sum + row.rightBestCoverage, 0), positives.length),
    needsAdjudication: rows.filter(row => row.needsAdjudication).length,
  };
}
function locate(dataset: Dataset): Map<string, LocatedCase> {
  const map = new Map<string, LocatedCase>();
  for (const document of dataset.documents) {
    for (const row of document.cases) {
      if (map.has(row.id)) invalid();
      map.set(row.id, { document, row });
    }
  }
  return map;
}
function assertSameDocument(a: DocumentLabels, b: DocumentLabels) {
  // Snapshot filenames may differ across independent annotation sessions,
  // but the actual content fingerprint must be identical.
  if (a.id !== b.id || a.family !== b.family || a.split !== b.split ||
      a.snapshot_sha256 !== b.snapshot_sha256) invalid();
}
function assertSameCase(a: LocatedCase, b: LocatedCase) {
  assertSameDocument(a.document, b.document);
  if (a.row.id !== b.row.id || a.row.family !== b.row.family ||
      a.row.question !== b.row.question || a.row.scope !== b.row.scope ||
      a.row.page !== b.row.page || !sameArray(sorted(a.row.slices), sorted(b.row.slices))) invalid();
}
function unpaired(item: LocatedCase, side: UnpairedCase['side']): UnpairedCase {
  return { id: item.row.id, document: item.document.id, family: item.document.family,
    split: item.document.split, side };
}

/** Validate both independently authored manifests against their exact
 * snapshots before comparing. Missing cases remain explicit, not negative
 * labels, and no disagreement is silently resolved or merged.
 */
export function compareAnnotations(left: DatasetSide, right: DatasetSide): AgreementReport {
  if (left.dataset.kind !== right.dataset.kind) invalid();
  loadDataset(left.dataset, left.artifacts);
  loadDataset(right.dataset, right.artifacts);
  const leftDocs = new Map(left.dataset.documents.map(doc => [doc.id, doc]));
  for (const document of right.dataset.documents) {
    const other = leftDocs.get(document.id);
    if (other) assertSameDocument(other, document);
  }
  const a = locate(left.dataset), b = locate(right.dataset);
  const paired: AgreementCase[] = [], missing: UnpairedCase[] = [];
  for (const id of sorted(new Set([...a.keys(), ...b.keys()]))) {
    const first = a.get(id), second = b.get(id);
    if (!first) { missing.push(unpaired(second!, 'right')); continue; }
    if (!second) { missing.push(unpaired(first, 'left')); continue; }
    assertSameCase(first, second);
    const leftLabel = first.row.label, rightLabel = second.row.label;
    const sameKind = leftLabel.kind === rightLabel.kind;
    const evidence = leftLabel.kind === 'answerable' && rightLabel.kind === 'answerable'
      ? compareEvidenceLabels(leftLabel, rightLabel) : null;
    paired.push({ id, document: first.document.id, family: first.document.family, split: first.document.split,
      slices: sorted(first.row.slices), leftKind: leftLabel.kind, rightKind: rightLabel.kind,
      sameKind, evidence, needsAdjudication: !sameKind || (evidence !== null && !evidence.exactAlternatives) });
  }
  if (!paired.length) invalid();
  const families = sorted(new Set(paired.map(row => row.family)));
  const slices = sorted(new Set(paired.flatMap(row => row.slices)));
  return {
    format: 'noticebridge-annotation-agreement', version: 1,
    leftDataset: left.dataset.id, rightDataset: right.dataset.id, labelKind: left.dataset.kind,
    authority_verified: false,
    policy: 'Descriptive annotation agreement only. Neither reviewer is established as correct; resolve disagreements against the original PDFs.',
    summary: summarizeAgreement(paired),
    splits: (['development', 'holdout'] as const).map(split => ({
      split, summary: summarizeAgreement(paired.filter(row => row.split === split)),
    })),
    families: families.map(family => ({ family, summary: summarizeAgreement(paired.filter(row => row.family === family)) })),
    slices: slices.map(slice => ({ slice, summary: summarizeAgreement(paired.filter(row => row.slices.includes(slice))) })),
    paired, unpaired: missing, completePairing: missing.length === 0,
  };
}
