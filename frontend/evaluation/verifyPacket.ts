/** Verify a private evidence packet against the exact native corpus snapshot. */
import { resolve, extname } from 'node:path';
import { verifyEvidencePacket, renderPacketHtml, MAX_PACKET_BYTES, MAX_PACKET_HTML_BYTES } from '../src/pdfChatReviewPacket';
import { MAX_CORPUS_SNAPSHOT_BYTES } from '../src/pdfChatCorpusSnapshot';
import { readBounded, publishExclusive } from './localFiles';

const help = 'Usage: npm run verify:packet -- --packet packet.json --snapshot snapshot.json [--html reading-copy.html]';
async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { console.log(help); return 0; }
  try {
    if ((args.length !== 4 && args.length !== 6) || args[0] !== '--packet' ||
        args[2] !== '--snapshot' || (args.length === 6 && args[4] !== '--html') ||
        extname(args[1]).toLowerCase() !== '.json' || extname(args[3]).toLowerCase() !== '.json' ||
        (args.length === 6 && extname(args[5]).toLowerCase() !== '.html')) throw new Error('Invalid arguments.');
    const packet = readBounded(resolve(args[1]), MAX_PACKET_BYTES);
    const snapshot = readBounded(resolve(args[3]), MAX_CORPUS_SNAPSHOT_BYTES);
    const verified = await verifyEvidencePacket(packet.text, snapshot.text);
    if (args.length === 6) publishExclusive(resolve(args[5]), renderPacketHtml(verified.packet), MAX_PACKET_HTML_BYTES);
    console.log(JSON.stringify({ consistent: true, authority_verified: false,
      packet_sha256: packet.sha256, snapshot_sha256: snapshot.sha256,
      sources: verified.packet.sources.length, entries: verified.packet.entries.length,
      counts: verified.packet.counts }));
    return 0;
  } catch {
    console.error('Evidence packet verification failed: inconsistent input, source binding, or destination.');
    console.error(help);
    return 1;
  }
}
// Keep the Node CLI compatible with Vite's default ES2020 SSR build target.
// Do not change the browser build target just to support top-level await here.
void main(process.argv.slice(2)).then(code => {
  process.exitCode = code;
}, () => {
  // Unexpected rejections must not disclose private packet contents.
  console.error('Evidence packet verification failed.');
  process.exitCode = 1;
});
