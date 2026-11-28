/** Generate or replay a private dataset preflight against pinned native snapshots. */
import { extname, resolve } from 'node:path';
import { readDatasetInput } from './datasetLocalInput';
import { readBounded, publishExclusive } from './localFiles';
import { preflightDataset, replayPreflight, MAX_PREFLIGHT_BYTES } from './datasetPreflight';

const HELP = 'Usage: npm run preflight:retrieval -- --manifest labels.json --threshold 0.8 --output preflight.json [--verify]';
type Options = { manifest: string; output: string; threshold: number; verify: boolean };
function invalid(): never { throw new Error('Invalid preflight arguments.'); }
function options(args: string[]): Options {
  const values = new Map<string, string>();
  let verify = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--verify') {
      if (verify) invalid();
      verify = true; continue;
    }
    const value = args[++i];
    if (!['--manifest', '--threshold', '--output'].includes(key) || !value || value.startsWith('--') || values.has(key)) invalid();
    values.set(key, value);
  }
  const manifest = values.get('--manifest'), output = values.get('--output'), threshold = values.get('--threshold');
  if (!manifest || !output || !threshold || extname(manifest).toLowerCase() !== '.json' ||
      extname(output).toLowerCase() !== '.json' || !/^(?:0\.[0-9]{1,3}|1(?:\.0{1,3})?)$/.test(threshold)) invalid();
  return { manifest: resolve(manifest), output: resolve(output), threshold: Number(threshold), verify };
}
export function main(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return 0; }
  try {
    const config = options(args), source = readDatasetInput(config.manifest);
    const settings = { similarityThreshold: config.threshold };
    const report = config.verify
      ? replayPreflight(readBounded(config.output, MAX_PREFLIGHT_BYTES).text, source, settings)
      : (() => {
        const result = preflightDataset(source, settings);
        publishExclusive(config.output, result.text, MAX_PREFLIGHT_BYTES);
        return result.report;
      })();
    console.log(JSON.stringify({ consistent: true, verified_replay: config.verify,
      authority_verified: false, release_approved: false, manifest_sha256: report.manifest_sha256,
      summary: report.summary }));
    return 0;
  } catch {
    console.error('Dataset preflight failed: invalid source, settings, report, or unavailable destination.');
    console.error(HELP);
    return 1;
  }
}
process.exitCode = main(process.argv.slice(2));
