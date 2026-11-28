/** Compose labels from separate annotation sessions, in one trusted local directory. */
import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { composeDataset, MAX_INPUT_MANIFESTS, type NamedManifest } from './datasetCompose';
import { parseDataset, MAX_MANIFEST_BYTES, MAX_DATASET_TOTAL_BYTES, type DatasetArtifact } from './retrievalDataset';
import { MAX_CORPUS_SNAPSHOT_BYTES } from '../src/pdfChatCorpusSnapshot';
import { localFile, publishExclusive, readBounded } from './localFiles';

const help = 'Usage: npm run compose:retrieval -- --directory DIR --id DATASET --output labels.json --inputs first.json second.json ...';
export function main(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') { console.log(help); return 0; }
  try {
    if (args.length < 8 || args[0] !== '--directory' || args[2] !== '--id' ||
        args[4] !== '--output' || args[6] !== '--inputs' || args.length - 7 > MAX_INPUT_MANIFESTS) {
      throw new Error('Invalid arguments.');
    }
    const root = realpathSync(resolve(args[1])), id = args[3], filename = args[5];
    if (!/^[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(filename)) throw new Error('Invalid destination.');
    const output = resolve(root, filename);
    if (dirname(output) !== root || basename(output) !== filename) throw new Error('Invalid destination.');
    const inputs: NamedManifest[] = [];
    const artifacts: DatasetArtifact[] = [];
    const snapshotNames = new Set<string>(), manifestNames = new Set<string>();
    let bytes = 0;
    for (const name of args.slice(7)) {
      if (name === filename || manifestNames.has(name)) throw new Error('Conflicting manifest path.');
      manifestNames.add(name);
      const input = readBounded(localFile(root, name), MAX_MANIFEST_BYTES);
      inputs.push({ name, text: input.text, sha256: input.sha256 });
      const dataset = parseDataset(input.text);
      for (const document of dataset.documents) {
        if (document.snapshot === filename || snapshotNames.has(document.snapshot)) throw new Error('Conflicting snapshot path.');
        snapshotNames.add(document.snapshot);
        const artifact = readBounded(localFile(root, document.snapshot),
          Math.min(MAX_CORPUS_SNAPSHOT_BYTES, MAX_DATASET_TOTAL_BYTES - bytes));
        bytes += artifact.bytes;
        artifacts.push({ name: document.snapshot, text: artifact.text, sha256: artifact.sha256 });
      }
    }
    const result = composeDataset(id, inputs, artifacts);
    publishExclusive(output, result.manifest, MAX_MANIFEST_BYTES);
    // Print counts and anonymous identifiers, never question/source text.
    console.log(JSON.stringify(result.audit));
    return 0;
  } catch {
    console.error('Dataset composition failed: conflicting identities, invalid labels, source binding, or destination.');
    console.error(help);
    return 1;
  }
}
process.exitCode = main(process.argv.slice(2));
