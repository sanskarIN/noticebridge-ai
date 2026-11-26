/** Offline CLI. Uses a bounded local JSON manifest and private native snapshots. */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readSync, writeFileSync,
  realpathSync, lstatSync } from 'node:fs';
import { dirname, resolve, basename, extname } from 'node:path';
import { parseDataset, loadDataset, evaluateDataset, MAX_MANIFEST_BYTES,
  MAX_DATASET_TOTAL_BYTES, type DatasetArtifact, type Split } from './retrievalDataset';
import { MAX_CORPUS_SNAPSHOT_BYTES } from '../src/pdfChatCorpusSnapshot';

function readBounded(path: string, maximum: number): { text: string; sha256: string; bytes: number } {
  // Only regular local files, no symlink following when the platform supports it.
  if (!lstatSync(path).isFile()) throw new Error('Expected a regular local file.');
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximum) throw new Error('Input size limit.');
    const data = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(descriptor, data, offset, data.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset !== stat.size) throw new Error('Input changed during read.');
    const bytes = data.subarray(0, offset);
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: offset };
  } finally { closeSync(descriptor); }
}
function argumentsFor(args: string[]): { manifest: string; output: string; split: Split } {
  if (args.length !== 6 || args[0] !== '--manifest' || args[2] !== '--split' || args[4] !== '--output' ||
      (args[3] !== 'development' && args[3] !== 'holdout') ||
      extname(args[1]).toLowerCase() !== '.json' || extname(args[5]).toLowerCase() !== '.json') {
    throw new Error('Invalid arguments.');
  }
  return { manifest: resolve(args[1]), split: args[3], output: resolve(args[5]) };
}
const help = 'Usage: npm run evaluate:retrieval -- --manifest labels.json --split development|holdout --output report.json';
export function main(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') { console.log(help); return 0; }
  try {
    const options = argumentsFor(args);
    const manifest = readBounded(options.manifest, MAX_MANIFEST_BYTES);
    const dataset = parseDataset(manifest.text);
    const root = realpathSync(dirname(options.manifest));
    const artifacts: DatasetArtifact[] = [];
    let bytes = 0;
    for (const document of dataset.documents) {
      const filename = resolve(root, document.snapshot);
      if (dirname(filename) !== root || basename(filename) !== document.snapshot ||
          realpathSync(filename) !== filename) throw new Error('Snapshot path escapes dataset.');
      const artifact = readBounded(filename, Math.min(MAX_CORPUS_SNAPSHOT_BYTES, MAX_DATASET_TOTAL_BYTES - bytes));
      bytes += artifact.bytes;
      artifacts.push({ name: document.snapshot, text: artifact.text, sha256: artifact.sha256 });
    }
    const loaded = loadDataset(dataset, artifacts);
    const report = evaluateDataset(dataset, loaded, options.split);
    const output = JSON.stringify({ ...report, manifest_sha256: manifest.sha256 }, null, 2) + '\n';
    // Existing files are never replaced. Private data stays out of stdout and stderr.
    writeFileSync(options.output, output, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ dataset: report.dataset, split: report.split,
      documents: report.documents.length, cases: report.modes[0].totals.cases,
      integrity_violations: report.integrity_violations }));
    return report.integrity_violations ? 2 : 0;
  } catch {
    console.error('Evaluation failed: invalid dataset, unreadable source, or unavailable output destination.');
    console.error(help);
    return 1;
  }
}
process.exitCode = main(process.argv.slice(2));
