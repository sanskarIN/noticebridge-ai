/** Freeze or replay a preflight-reviewed and uncertainty-aware study. */
import { extname, resolve } from 'node:path';
import { readDatasetInput } from './datasetLocalInput';
import { readBounded, publishExclusive } from './localFiles';
import { MAX_PREFLIGHT_BYTES } from './datasetPreflight';
import { MAX_REVIEW_QUEUE_BYTES } from './preflightReview';
import { freezeStudyPlan, readStudyPolicy, qualifyStudy, replayStudy,
  MAX_STUDY_PLAN_BYTES, MAX_STUDY_REPORT_BYTES } from './studyQualification';

const HELP = [
  'Usage:',
  '  npm run qualify:study -- freeze --manifest labels.json --preflight preflight.json --queue queue.json --policy policy.json --output plan.json',
  '  npm run qualify:study -- run --manifest labels.json --preflight preflight.json --queue queue.json --plan plan.json --output report.json',
  '  npm run qualify:study -- verify --manifest labels.json --preflight preflight.json --queue queue.json --plan plan.json --output report.json',
].join('\n');
type Action = 'freeze' | 'run' | 'verify';
type Options = {
  action: Action;
  manifest: string;
  preflight: string;
  queue: string;
  secondary: string;
  output: string;
};
function invalid(): never { throw new Error('Invalid study qualification arguments.'); }
function options(args: string[]): Options {
  const [action, ...rest] = args;
  if (action !== 'freeze' && action !== 'run' && action !== 'verify') invalid();
  const secondary = action === 'freeze' ? '--policy' : '--plan';
  const allowed = new Set(['--manifest', '--preflight', '--queue', secondary, '--output']);
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!allowed.has(key) || values.has(key) || !value || value.startsWith('--') ||
        extname(value).toLowerCase() !== '.json') invalid();
    values.set(key, resolve(value));
  }
  if (values.size !== allowed.size || new Set(values.values()).size !== allowed.size) invalid();
  return {
    action,
    manifest: values.get('--manifest')!,
    preflight: values.get('--preflight')!,
    queue: values.get('--queue')!,
    secondary: values.get(secondary)!,
    output: values.get('--output')!,
  };
}
export function main(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') {
    console.log(HELP);
    return 0;
  }
  try {
    const config = options(args);
    const input = {
      ...readDatasetInput(config.manifest),
      preflightText: readBounded(config.preflight, MAX_PREFLIGHT_BYTES).text,
      queueText: readBounded(config.queue, MAX_REVIEW_QUEUE_BYTES).text,
    };
    const secondary = readBounded(config.secondary, MAX_STUDY_PLAN_BYTES).text;
    if (config.action === 'freeze') {
      const plan = freezeStudyPlan(readStudyPolicy(secondary), input);
      publishExclusive(config.output, plan, MAX_STUDY_PLAN_BYTES);
      console.log(JSON.stringify({ frozen: true, evaluated: false, release_approved: false }));
      return 0;
    }
    const report = config.action === 'verify'
      ? replayStudy(readBounded(config.output, MAX_STUDY_REPORT_BYTES).text, secondary, input)
      : (() => {
        const result = qualifyStudy(secondary, input);
        publishExclusive(config.output, result.text, MAX_STUDY_REPORT_BYTES);
        return result.report;
      })();
    console.log(JSON.stringify({
      consistent: true,
      verified_replay: config.action === 'verify',
      point_qualified: report.point_qualified,
      uncertainty_qualified: report.uncertainty_qualified,
      study_qualified: report.study_qualified,
      release_approved: false,
      authority_verified: false,
      reviewer_identity_verified: false,
      integrity_violations: report.integrity_violations,
      checks: report.checks.length,
      failed_checks: report.checks.filter(check => !check.passed).length,
      point_failures: report.point_failures.length,
    }));
    return report.study_qualified ? 0 : 2;
  } catch {
    console.error('Study qualification failed: invalid source, review, policy, plan, report, or destination.');
    console.error(HELP);
    return 1;
  }
}
process.exitCode = main(process.argv.slice(2));
