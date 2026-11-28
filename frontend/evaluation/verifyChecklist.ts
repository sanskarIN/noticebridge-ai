/** Verify a private checklist against an independently selected native snapshot. */
import { extname, resolve } from 'node:path';
import { readBounded, publishExclusive } from './localFiles';
import { MAX_CHECKLIST_REPORT_BYTES, verifyChecklistReport } from '../src/pdfChatChecklistExchange';
import { MAX_CORPUS_SNAPSHOT_BYTES } from '../src/pdfChatCorpusSnapshot';
import { MAX_CHECKLIST_COPY_BYTES, prepareChecklistReadingCopy, type ChecklistCopyFormat } from '../src/pdfChatChecklistReadingCopy';

const HELP = 'Usage: npm run verify:checklist -- --report report.json --snapshot snapshot.json [--html copy.html | --csv copy.csv]';
type Options = { report: string; snapshot: string; copy?: { format: ChecklistCopyFormat; path: string } };
function options(args: string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--report', '--snapshot', '--html', '--csv'].includes(key) ||
        values.has(key) || !value || value.startsWith('--')) throw new Error('Invalid arguments.');
    values.set(key, value);
  }
  const report = values.get('--report'), snapshot = values.get('--snapshot');
  const html = values.get('--html'), csv = values.get('--csv');
  if (!report || !snapshot || (html && csv) ||
      extname(report).toLowerCase() !== '.json' || extname(snapshot).toLowerCase() !== '.json' ||
      (html && extname(html).toLowerCase() !== '.html') || (csv && extname(csv).toLowerCase() !== '.csv')) {
    throw new Error('Invalid arguments.');
  }
  return { report: resolve(report), snapshot: resolve(snapshot),
    ...(html ? { copy: { format: 'html' as const, path: resolve(html) } } :
      csv ? { copy: { format: 'csv' as const, path: resolve(csv) } } : {}) };
}
export async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return 0; }
  try {
    const config = options(args);
    const report = readBounded(config.report, MAX_CHECKLIST_REPORT_BYTES);
    const snapshot = readBounded(config.snapshot, MAX_CORPUS_SNAPSHOT_BYTES);
    const verified = await verifyChecklistReport(report.text, snapshot.text);
    if (config.copy) {
      const copy = await prepareChecklistReadingCopy(report.text, snapshot.text, config.copy.format);
      publishExclusive(config.copy.path, copy.text, MAX_CHECKLIST_COPY_BYTES);
    }
    // No question text, evidence excerpts, notes, or filesystem paths.
    console.log(JSON.stringify({ consistent: true, authority_verified: false,
      report_sha256: report.sha256, snapshot_sha256: snapshot.sha256,
      summary: verified.summary, reading_copy: config.copy?.format ?? null }));
    return 0;
  } catch {
    console.error('Checklist verification failed: invalid report, mismatched snapshot, or unavailable output.');
    console.error(HELP);
    return 1;
  }
}
void main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
