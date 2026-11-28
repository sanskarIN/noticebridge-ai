/** Local-only descriptive uncertainty report. */
import { extname, resolve } from 'node:path';
import { readBounded, publishExclusive } from './localFiles';
import { MAX_EVALUATION_REPORT_BYTES } from './reportAudit';
import { analyzeUncertainty, replayUncertainty, MAX_UNCERTAINTY_BYTES, type Settings } from './retrievalUncertainty';

const HELP = 'Usage: npm run uncertainty:retrieval -- --report evaluation.json --output uncertainty.json --seed 123 --resamples 1000 --level 0.95 [--slice deadline] [--verify]';
type Options = { input: string; output: string; settings: Settings; slices: string[]; verify: boolean };
function invalid(): never { throw new Error('Invalid uncertainty arguments.'); }
function options(args: string[]): Options {
  const values = new Map<string, string>(), slices: string[] = [];
  let verify = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--verify') {
      if (verify) invalid();
      verify = true; continue;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) invalid();
    if (key === '--slice') { slices.push(value); continue; }
    if (!['--report', '--output', '--seed', '--resamples', '--level'].includes(key) || values.has(key)) invalid();
    values.set(key, value);
  }
  const input = values.get('--report'), output = values.get('--output'), seed = values.get('--seed'),
    resamples = values.get('--resamples'), level = values.get('--level');
  if (!input || !output || !seed || !resamples || !level ||
      extname(input).toLowerCase() !== '.json' || extname(output).toLowerCase() !== '.json' ||
      !/^[1-9]\d{0,9}$/.test(seed) || !/^[1-9]\d{0,4}$/.test(resamples) ||
      !['0.9', '0.95', '0.99'].includes(level)) invalid();
  return { input: resolve(input), output: resolve(output),
    settings: { seed: Number(seed), resamples: Number(resamples), level: Number(level) as Settings['level'] }, slices, verify };
}
export function main(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return 0; }
  try {
    const config = options(args);
    const source = readBounded(config.input, MAX_EVALUATION_REPORT_BYTES);
    const report = config.verify
      ? replayUncertainty(readBounded(config.output, MAX_UNCERTAINTY_BYTES).text, source.text, config.settings, config.slices)
      : (() => {
        const result = analyzeUncertainty(source.text, config.settings, config.slices);
        publishExclusive(config.output, result.text, MAX_UNCERTAINTY_BYTES);
        return result.report;
      })();
    console.log(JSON.stringify({ consistent: true, verified_replay: config.verify, authority_verified: false,
      release_approved: false, input_sha256: report.input_sha256, manifest_sha256: report.manifest_sha256,
      families: report.cohort.families, cases: report.cohort.cases, slices: report.slices.length,
      resamples: report.settings.resamples }));
    return 0;
  } catch {
    console.error('Uncertainty analysis failed: invalid settings, inconsistent input, or unavailable output.');
    console.error(HELP);
    return 1;
  }
}
process.exitCode = main(process.argv.slice(2));
