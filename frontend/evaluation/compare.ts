/** Audit two pinned reports and publish their paired descriptive comparison. */
import { resolve, extname } from 'node:path';
import { auditReport, compareReports, MAX_EVALUATION_REPORT_BYTES } from './reportAudit';
import { publishExclusive, readBounded } from './localFiles';

const help = 'Usage: npm run compare:retrieval -- --before before.json --after after.json --output comparison.json';
export function main(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') { console.log(help); return 0; }
  try {
    if (args.length !== 6 || args[0] !== '--before' || args[2] !== '--after' || args[4] !== '--output' ||
        [args[1], args[3], args[5]].some(path => extname(path).toLowerCase() !== '.json')) {
      throw new Error('Invalid arguments.');
    }
    const old = readBounded(resolve(args[1]), MAX_EVALUATION_REPORT_BYTES);
    const next = readBounded(resolve(args[3]), MAX_EVALUATION_REPORT_BYTES);
    const result = compareReports(auditReport(old.text), auditReport(next.text));
    const text = JSON.stringify({ ...result, before_sha256: old.sha256, after_sha256: next.sha256 }, null, 2) + '\n';
    publishExclusive(resolve(args[5]), text, MAX_EVALUATION_REPORT_BYTES);
    console.log(JSON.stringify({ dataset: result.dataset, split: result.split,
      integrity_regression: result.integrity_regression,
      modes: result.modes.map(mode => ({ mode: mode.mode, positiveEvidence: mode.positiveEvidence,
        negativeAbstention: mode.negativeAbstention })) }));
    return result.integrity_regression ? 2 : 0;
  } catch {
    console.error('Report comparison failed: malformed, incomparable or unavailable files.');
    console.error(help);
    return 1;
  }
}
process.exitCode = main(process.argv.slice(2));
