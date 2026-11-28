/** Offline verification of a private, manually selected alignment report. */
import { extname, resolve } from 'node:path';
import { readBounded } from './localFiles';
import { MAX_ALIGNMENT_REPORT_BYTES, verifyAlignmentReport } from '../src/pdfChatAlignmentExchange';
import { MAX_CORPUS_SNAPSHOT_BYTES } from '../src/pdfChatCorpusSnapshot';

const HELP = 'Usage: npm run verify:alignment -- --report alignment.json --snapshot snapshot.json';
export async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return 0; }
  try {
    if (args.length !== 4 || args[0] !== '--report' || args[2] !== '--snapshot' ||
        extname(args[1]).toLowerCase() !== '.json' || extname(args[3]).toLowerCase() !== '.json') {
      throw new Error('Invalid arguments.');
    }
    const report = readBounded(resolve(args[1]), MAX_ALIGNMENT_REPORT_BYTES);
    const snapshot = readBounded(resolve(args[3]), MAX_CORPUS_SNAPSHOT_BYTES);
    const replayed = await verifyAlignmentReport(report.text, snapshot.text);
    console.log(JSON.stringify({ consistent: true, authority_verified: false,
      report_sha256: report.sha256, snapshot_sha256: snapshot.sha256, summary: replayed.summary }));
    return 0;
  } catch {
    console.error('Alignment verification failed: invalid or mismatched local evidence files.');
    console.error(HELP);
    return 1;
  }
}
void main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
