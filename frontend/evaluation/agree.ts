/** Compare independent reviewer labels using local, pinned source snapshots. */
import { dirname, extname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { parseDataset, MAX_MANIFEST_BYTES, MAX_DATASET_TOTAL_BYTES, type DatasetArtifact } from './retrievalDataset';
import { compareAnnotations, MAX_AGREEMENT_OUTPUT_BYTES } from './annotationAgreement';
import { MAX_CORPUS_SNAPSHOT_BYTES } from '../src/pdfChatCorpusSnapshot';
import { localFile, readBounded, publishExclusive } from './localFiles';

const help = 'Usage: npm run agree:retrieval -- --left reviewer-a/labels.json --right reviewer-b/labels.json --output agreement.json';
function readSide(path: string) {
  const manifest = readBounded(path, MAX_MANIFEST_BYTES);
  const dataset = parseDataset(manifest.text);
  const root = realpathSync(dirname(path));
  const artifacts: DatasetArtifact[] = [];
  let bytes = 0;
  for (const document of dataset.documents) {
    const file = readBounded(localFile(root, document.snapshot),
      Math.min(MAX_CORPUS_SNAPSHOT_BYTES, MAX_DATASET_TOTAL_BYTES - bytes));
    bytes += file.bytes;
    artifacts.push({ name: document.snapshot, text: file.text, sha256: file.sha256 });
  }
  return { dataset, artifacts, manifestHash: manifest.sha256 };
}
export function main(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') { console.log(help); return 0; }
  try {
    if (args.length !== 6 || args[0] !== '--left' || args[2] !== '--right' || args[4] !== '--output' ||
        [args[1], args[3], args[5]].some(path => extname(path).toLowerCase() !== '.json')) {
      throw new Error('Invalid arguments.');
    }
    const left = readSide(resolve(args[1])), right = readSide(resolve(args[3]));
    const result = compareAnnotations(left, right);
    const report = { ...result, left_manifest_sha256: left.manifestHash, right_manifest_sha256: right.manifestHash };
    publishExclusive(resolve(args[5]), JSON.stringify(report, null, 2) + '\n', MAX_AGREEMENT_OUTPUT_BYTES);
    console.log(JSON.stringify({ paired: result.summary.pairedCases, unpaired: result.unpaired.length,
      same_kind: result.summary.sameKind, needs_adjudication: result.summary.needsAdjudication,
      both_answerable: result.summary.bothAnswerable,
      exact_alternatives: result.summary.exactAlternativeMatches }));
    return 0;
  } catch {
    console.error('Annotation agreement failed: source, question, label or output binding is invalid.');
    console.error(help);
    return 1;
  }
}
process.exitCode = main(process.argv.slice(2));
