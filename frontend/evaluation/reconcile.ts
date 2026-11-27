/** Produce or replay a reconciled manifest beside the first review's snapshots. */
import { dirname, extname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { parseDataset, MAX_MANIFEST_BYTES, MAX_DATASET_TOTAL_BYTES, type DatasetArtifact } from './retrievalDataset';
import { reconcileAnnotations, replayReconciliation, type ReviewInput } from './annotationReconciliation';
import { MAX_CORPUS_SNAPSHOT_BYTES } from '../src/pdfChatCorpusSnapshot';
import { localFile, readBounded, publishExclusive } from './localFiles';

const HELP = 'Usage: npm run reconcile:retrieval -- --left first/labels.json --right second/labels.json [--third third/labels.json] --id reconciled --output first/reconciled.json [--verify]';
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
type Options = { left: string; right: string; third?: string; id: string; output: string; verify: boolean };

function fail(): never { throw new Error('Invalid reconciliation arguments or destination.'); }
function options(args: string[]): Options {
  const values = new Map<string, string>();
  let verify = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--verify') {
      if (verify) fail();
      verify = true;
      continue;
    }
    if (!['--left', '--right', '--third', '--id', '--output'].includes(key) || values.has(key)) fail();
    const value = args[++i];
    if (!value || value.startsWith('--')) fail();
    values.set(key, value);
  }
  const left = values.get('--left'), right = values.get('--right'), third = values.get('--third');
  const id = values.get('--id'), output = values.get('--output');
  if (!left || !right || !id || !ID.test(id) || !output ||
      [left, right, output, ...(third ? [third] : [])].some(path => extname(path).toLowerCase() !== '.json')) fail();
  return { left: resolve(left), right: resolve(right), ...(third ? { third: resolve(third) } : {}),
    id, output: resolve(output), verify };
}
function readSide(path: string): ReviewInput {
  const manifest = readBounded(path, MAX_MANIFEST_BYTES);
  const dataset = parseDataset(manifest.text);
  const root = realpathSync(dirname(path));
  const artifacts: DatasetArtifact[] = [];
  let bytes = 0;
  for (const document of dataset.documents) {
    const source = readBounded(localFile(root, document.snapshot),
      Math.min(MAX_CORPUS_SNAPSHOT_BYTES, MAX_DATASET_TOTAL_BYTES - bytes));
    bytes += source.bytes;
    artifacts.push({ name: document.snapshot, text: source.text, sha256: source.sha256 });
  }
  return { manifest: manifest.text, artifacts };
}
export function main(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') {
    console.log(HELP);
    return 0;
  }
  try {
    const config = options(args);
    // Do not emit a manifest whose relative snapshot paths point elsewhere.
    if (realpathSync(dirname(config.left)) !== realpathSync(dirname(config.output))) fail();
    const inputs = [config.left, config.right, ...(config.third ? [config.third] : [])].map(path => realpathSync(path));
    if (new Set(inputs).size !== inputs.length) fail();
    if (config.verify && inputs.includes(realpathSync(config.output))) fail();
    const left = readSide(config.left), right = readSide(config.right);
    const third = config.third ? readSide(config.third) : undefined;
    const audit = config.verify
      ? replayReconciliation(readBounded(config.output, MAX_MANIFEST_BYTES).text, config.id, left, right, third)
      : (() => {
        const result = reconcileAnnotations(config.id, left, right, third);
        publishExclusive(config.output, result.manifest, MAX_MANIFEST_BYTES);
        return result.audit;
      })();
    // This is anonymous aggregate metadata and fingerprints only; no cases,
    // source excerpts, question wording, local paths or private annotations.
    console.log(JSON.stringify({ consistent: true, verified_replay: config.verify,
      authority_verified: false, reviewer_identity_verified: false,
      manifest_sha256: audit.manifest_sha256, inputs: audit.inputs,
      label_kind: audit.label_kind, documents: audit.documents, families: audit.families,
      cases: audit.cases, agreed: audit.agreed, third_reviewed: audit.third_reviewed,
      by_split: audit.by_split }));
    return 0;
  } catch {
    console.error('Annotation reconciliation failed: incomplete, incomparable, invalid source or unavailable output.');
    console.error(HELP);
    return 1;
  }
}
process.exitCode = main(process.argv.slice(2));
