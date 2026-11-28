/** Freeze, qualify and replay offline retrieval gates. */
import { realpathSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { parseDataset, MAX_MANIFEST_BYTES, MAX_DATASET_TOTAL_BYTES, type DatasetArtifact } from './retrievalDataset';
import { MAX_CORPUS_SNAPSHOT_BYTES } from '../src/pdfChatCorpusSnapshot';
import { localFile, readBounded, publishExclusive } from './localFiles';
import { freezeGatePlan, qualifyRetrieval, replayGate, readGatePolicy,
  MAX_GATE_PLAN_BYTES, MAX_GATE_REPORT_BYTES, type GateInput } from './retrievalGate';

const HELP = 'Usage: npm run qualify:retrieval -- freeze --manifest labels.json --policy policy.json --output plan.json\n' +
  '       npm run qualify:retrieval -- run --manifest labels.json --plan plan.json --output gate.json\n' +
  '       npm run qualify:retrieval -- verify --manifest labels.json --plan plan.json --output gate.json';
type Action = 'freeze' | 'run' | 'verify';
type Options = { action: Action; manifest: string; secondary: string; output: string };
function invalid(): never { throw new Error('Invalid gate command.'); }
function options(args: string[]): Options {
  if (args.length !== 7 || !['freeze', 'run', 'verify'].includes(args[0]) ||
      args[1] !== '--manifest' || args[3] !== (args[0] === 'freeze' ? '--policy' : '--plan') ||
      args[5] !== '--output' || [args[2], args[4], args[6]].some(value => extname(value).toLowerCase() !== '.json')) invalid();
  const result = { action: args[0] as Action, manifest: resolve(args[2]), secondary: resolve(args[4]), output: resolve(args[6]) };
  const inputPaths = [realpathSync(result.manifest), realpathSync(result.secondary)];
  if (new Set(inputPaths).size !== inputPaths.length) invalid();
  if (result.action === 'verify' && inputPaths.includes(realpathSync(result.output))) invalid();
  return result;
}
function readInput(path: string): GateInput {
  const manifest = readBounded(path, MAX_MANIFEST_BYTES);
  const dataset = parseDataset(manifest.text);
  const root = realpathSync(dirname(path));
  let bytes = 0;
  const artifacts: DatasetArtifact[] = dataset.documents.map(document => {
    const file = readBounded(localFile(root, document.snapshot),
      Math.min(MAX_CORPUS_SNAPSHOT_BYTES, MAX_DATASET_TOTAL_BYTES - bytes));
    bytes += file.bytes;
    return { name: document.snapshot, text: file.text, sha256: file.sha256 };
  });
  return { manifest: manifest.text, artifacts };
}
export function main(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return 0; }
  try {
    const config = options(args);
    const input = readInput(config.manifest);
    const secondary = readBounded(config.secondary, MAX_GATE_PLAN_BYTES);
    if (config.action === 'freeze') {
      const plan = freezeGatePlan(readGatePolicy(secondary.text), input);
      publishExclusive(config.output, plan, MAX_GATE_PLAN_BYTES);
      console.log(JSON.stringify({ frozen: true, evaluated: false, release_approved: false }));
      return 0;
    }
    const report = config.action === 'verify'
      ? replayGate(readBounded(config.output, MAX_GATE_REPORT_BYTES).text, secondary.text, input)
      : (() => {
        const result = qualifyRetrieval(secondary.text, input);
        publishExclusive(config.output, result.reportText, MAX_GATE_REPORT_BYTES);
        return result.report;
      })();
    console.log(JSON.stringify({ status: report.status, metric_qualified: report.metric_qualified,
      release_approved: false, authority_verified: false, reviewer_identity_verified: false,
      verified_replay: config.action === 'verify', failures: report.failures.length,
      integrity_violations: report.integrity_violations, plan_sha256: report.plan_sha256,
      manifest_sha256: report.manifest_sha256, evaluation_sha256: report.evaluation_sha256 }));
    return report.metric_qualified ? 0 : 2;
  } catch {
    console.error('Retrieval qualification failed: invalid policy, source binding, artifact, or destination.');
    console.error(HELP);
    return 1;
  }
}
process.exitCode = main(process.argv.slice(2));
