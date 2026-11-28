/** Compare and independently replay observations from two local checklist runs. */
import { extname, resolve } from 'node:path';
import { readBounded, publishExclusive } from './localFiles';
import { MAX_CHECKLIST_REPORT_BYTES } from '../src/pdfChatChecklistExchange';
import { MAX_CORPUS_SNAPSHOT_BYTES } from '../src/pdfChatCorpusSnapshot';
import { compareChecklistRuns, replayChecklistComparison, MAX_CHECKLIST_COMPARISON_BYTES } from '../src/pdfChatChecklistComparison';

const HELP = 'Usage: npm run compare:checklist -- --left-report a.json --left-snapshot a-snapshot.json --right-report b.json --right-snapshot b-snapshot.json --output comparison.json [--verify]';
const required = ['--left-report', '--left-snapshot', '--right-report', '--right-snapshot', '--output'] as const;
type Key = typeof required[number];
function options(args: string[]): { values: Record<Key, string>; verify: boolean } {
  const values = new Map<string, string>();
  let verify = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--verify') {
      if (verify) throw new Error('Duplicate verify flag.');
      verify = true;
      continue;
    }
    const value = args[++i];
    if (!required.includes(key as Key) || values.has(key) || !value || value.startsWith('--') ||
        extname(value).toLowerCase() !== '.json') throw new Error('Invalid arguments.');
    values.set(key, resolve(value));
  }
  if (values.size !== required.length) throw new Error('Missing arguments.');
  return { values: Object.fromEntries(values) as Record<Key, string>, verify };
}
export async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return 0; }
  try {
    const { values, verify } = options(args);
    const left = {
      report: readBounded(values['--left-report'], MAX_CHECKLIST_REPORT_BYTES).text,
      snapshot: readBounded(values['--left-snapshot'], MAX_CORPUS_SNAPSHOT_BYTES).text,
    };
    const right = {
      report: readBounded(values['--right-report'], MAX_CHECKLIST_REPORT_BYTES).text,
      snapshot: readBounded(values['--right-snapshot'], MAX_CORPUS_SNAPSHOT_BYTES).text,
    };
    const comparison = verify
      ? await replayChecklistComparison(readBounded(values['--output'], MAX_CHECKLIST_COMPARISON_BYTES).text, left, right)
      : await (async () => {
        const result = await compareChecklistRuns(left, right);
        publishExclusive(values['--output'], result.text, MAX_CHECKLIST_COMPARISON_BYTES);
        return result.comparison;
      })();
    // Do not expose question identifiers, source quotes, notes, or paths.
    console.log(JSON.stringify({ consistent: true, verified_replay: verify,
      authority_verified: false, left: comparison.left, right: comparison.right,
      summary: comparison.summary }));
    return 0;
  } catch {
    console.error('Checklist comparison failed: invalid or incomparable runs, or unavailable output.');
    console.error(HELP);
    return 1;
  }
}
void main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
