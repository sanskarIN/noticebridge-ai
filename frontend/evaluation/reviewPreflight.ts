/** Create a private decision queue, then audit or replay human dispositions. */
import { extname, resolve } from 'node:path';
import { readDatasetInput } from './datasetLocalInput';
import { readBounded, publishExclusive } from './localFiles';
import { MAX_PREFLIGHT_BYTES } from './datasetPreflight';
import { preparePreflightReview, auditPreflightReview, replayPreflightReview,
  MAX_REVIEW_QUEUE_BYTES } from './preflightReview';

const HELP = [
  'Usage:',
  '  npm run review:preflight -- prepare --manifest labels.json --preflight preflight.json --threshold 0.8 --output queue.json',
  '  npm run review:preflight -- audit --manifest labels.json --preflight preflight.json --threshold 0.8 --queue queue.json --output audit.json',
  '  npm run review:preflight -- verify --manifest labels.json --preflight preflight.json --threshold 0.8 --queue queue.json --output audit.json',
].join('\n');
type Action = 'prepare' | 'audit' | 'verify';
type Options = {
  action: Action;
  manifest: string;
  preflight: string;
  threshold: number;
  queue?: string;
  output: string;
};
function invalid(): never { throw new Error('Invalid preflight review arguments.'); }
function options(args: string[]): Options {
  const [action, ...rest] = args;
  if (action !== 'prepare' && action !== 'audit' && action !== 'verify') invalid();
  const allowed = new Set(['--manifest', '--preflight', '--threshold', '--output']);
  if (action !== 'prepare') allowed.add('--queue');
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!allowed.has(key) || values.has(key) || !value || value.startsWith('--')) invalid();
    values.set(key, value);
  }
  if (values.size !== allowed.size) invalid();
  const path = (key: string): string => {
    const value = values.get(key);
    if (!value || extname(value).toLowerCase() !== '.json') invalid();
    return resolve(value);
  };
  const threshold = values.get('--threshold')!;
  if (!/^(?:0\.[0-9]{1,3}|1(?:\.0{1,3})?)$/.test(threshold)) invalid();
  return { action, manifest: path('--manifest'), preflight: path('--preflight'),
    threshold: Number(threshold), output: path('--output'),
    ...(action !== 'prepare' ? { queue: path('--queue') } : {}) };
}
export function main(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') {
    console.log(HELP);
    return 0;
  }
  try {
    const config = options(args);
    const source = readDatasetInput(config.manifest);
    const preflight = readBounded(config.preflight, MAX_PREFLIGHT_BYTES).text;
    const settings = { similarityThreshold: config.threshold };
    if (config.action === 'prepare') {
      const result = preparePreflightReview(preflight, source, settings);
      publishExclusive(config.output, result.text, MAX_REVIEW_QUEUE_BYTES);
      console.log(JSON.stringify({ prepared: true, pair_leads: result.queue.pairs.length,
        case_leads: result.queue.cases.length, release_approved: false }));
      return 0;
    }
    const queue = readBounded(config.queue!, MAX_REVIEW_QUEUE_BYTES).text;
    const audit = config.action === 'verify'
      ? replayPreflightReview(readBounded(config.output, MAX_REVIEW_QUEUE_BYTES).text,
        queue, preflight, source, settings)
      : (() => {
        const result = auditPreflightReview(queue, preflight, source, settings);
        publishExclusive(config.output, result.text, MAX_REVIEW_QUEUE_BYTES);
        return result.audit;
      })();
    console.log(JSON.stringify({ consistent: true, verified_replay: config.action === 'verify',
      release_approved: false, all_leads_disposed_without_changes: audit.all_leads_disposed_without_changes,
      pair_decisions: audit.summary.pair_decisions, case_decisions: audit.summary.case_decisions }));
    return audit.all_leads_disposed_without_changes ? 0 : 2;
  } catch {
    console.error('Preflight review failed: invalid inputs, decision queue, audit, or destination.');
    console.error(HELP);
    return 1;
  }
}
process.exitCode = main(process.argv.slice(2));
