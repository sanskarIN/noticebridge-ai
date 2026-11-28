import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildIndex, type Corpus, type Passage } from '../src/pdfChatCore';
import { serializeCorpusSnapshot } from '../src/pdfChatCorpusSnapshot';
import { pinEvidence, updateEvidence } from '../src/pdfChatReviewWorkspace';
import { buildEvidencePacket, readEvidencePacket, renderPacketHtml, serializeEvidencePacket,
  verifyEvidencePacket, MAX_PACKET_BYTES } from '../src/pdfChatReviewPacket';

const rows: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Application fee: INR 500' },
  { role: 'original', page: 2, ordinal: 1, text: '<script>alert("fixture")</script> 😀' },
  { role: 'revised', page: 1, ordinal: 1, text: 'Application fee: INR 350' },
];
const index = buildIndex(rows), pins = { original: 'a'.repeat(64), revised: 'b'.repeat(64) };
const corpora = {
  original: { passages: rows.slice(0, 2), pageCount: 3, processedPages: 2, missingPages: [],
    limitedPages: [2], limited: true } satisfies Corpus,
  revised: { passages: rows.slice(2), pageCount: 1, processedPages: 1,
    missingPages: [], limitedPages: [], limited: false } satisfies Corpus,
};
let entries = pinEvidence(index, pinEvidence(index, [], rows[0]), rows[1]);
entries = updateEvidence(entries, 'original:2:1', { status: 'needs_followup', note: '<img src=x onerror=alert(1)> & "note"' });
const snapshot = serializeCorpusSnapshot(pins, corpora);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

test('packet reconstructs exact selected quotes, hashes and coverage without including unrelated text', async () => {
  const result = await buildEvidencePacket(index, pins, corpora, entries, true);
  expect(result.snapshot_sha256).toBe(sha(snapshot));
  expect(result.entries.map(row => row.native_text)).toEqual(rows.slice(0, 2).map(row => row.text));
  expect(result.entries[1].native_text_sha256).toBe(sha(rows[1].text));
  expect(result.entries[1].page_coverage).toBe('limited');
  expect(result.counts).toEqual({ unreviewed: 1, reviewed_manually: 0, needs_followup: 1 });
  expect(result.authority_verified).toBe(false);
  expect(encode(result)).not.toContain(rows[2].text);
  expect(result.sources[0].physical_pages).toBe(3);
  const checked = await verifyEvidencePacket(encode(result), snapshot);
  expect(checked.packet).toEqual(result);
  expect(checked.reviewEntries).toEqual(entries);
});
test('printable reading copy escapes arbitrary quote and annotation markup and disables active content', async () => {
  const packet = await buildEvidencePacket(index, pins, corpora, entries, true);
  const html = renderPacketHtml(packet);
  expect(html).toContain('&lt;script&gt;alert(&quot;fixture&quot;)&lt;/script&gt; 😀');
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;note&quot;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('<a ');
  expect(html).toContain('Content-Security-Policy');
  expect(html).toContain('Authority has not been verified');
});
for (const [name, mutate] of [
  ['quote', (value: any) => value.entries[0].native_text = 'forged'],
  ['text hash', (value: any) => value.entries[0].native_text_sha256 = 'c'.repeat(64)],
  ['role', (value: any) => value.entries[0].role = 'revised'],
  ['page', (value: any) => value.entries[0].physical_page = 2],
  ['ordinal', (value: any) => value.entries[0].fragment_ordinal = 2],
  ['coverage', (value: any) => value.entries[1].page_coverage = 'some_text'],
  ['status', (value: any) => value.entries[0].review_status = 'verified'],
  ['count', (value: any) => value.counts.unreviewed = 10],
  ['source pin', (value: any) => value.sources[0].sha256 = 'c'.repeat(64)],
  ['snapshot hash', (value: any) => value.snapshot_sha256 = 'c'.repeat(64)],
  ['authority', (value: any) => value.authority_verified = true],
  ['duplicate evidence', (value: any) => value.entries.push(value.entries[0])],
  ['extra claim', (value: any) => value.entries[0].answer = 'forged'],
] as const) {
  test('packet rejects altered ' + name, async () => {
    const value = await buildEvidencePacket(index, pins, corpora, entries, true);
    mutate(value);
    await expect(verifyEvidencePacket(encode(value), snapshot)).rejects.toThrow();
  });
}
test('changed extraction or source bytes cannot validate a previous packet', async () => {
  const text = await serializeEvidencePacket(index, pins, corpora, entries, true);
  await expect(verifyEvidencePacket(text, serializeCorpusSnapshot({ ...pins, original: 'c'.repeat(64) }, corpora))).rejects.toThrow();
  await expect(verifyEvidencePacket(text, serializeCorpusSnapshot(pins, { ...corpora,
    original: { ...corpora.original, limitedPages: [] } }))).rejects.toThrow();
});
test('export requires explicit consent and current canonical source identity', async () => {
  await expect(buildEvidencePacket(index, pins, corpora, entries, false)).rejects.toThrow();
  await expect(buildEvidencePacket(index, pins, corpora, [], true)).rejects.toThrow();
  await expect(buildEvidencePacket(buildIndex(rows.slice(0, 2)), pins, corpora, entries, true)).rejects.toThrow();
  await expect(buildEvidencePacket(index, pins, corpora, [{ ...entries[0],
    source: { ...entries[0].source, text: 'forged' } }], true)).rejects.toThrow();
});
test('file verification rejects noncanonical JSON, duplicate fields, oversized or malformed UTF-8', async () => {
  const text = await serializeEvidencePacket(index, pins, corpora, entries, true);
  await expect(verifyEvidencePacket(text.trim(), snapshot)).rejects.toThrow();
  await expect(verifyEvidencePacket(text.replace('"version": 1,', '"version": 1, "version": 1,'), snapshot)).rejects.toThrow();
  await expect(verifyEvidencePacket('x'.repeat(MAX_PACKET_BYTES + 1), snapshot)).rejects.toThrow();
  await expect(readEvidencePacket(new File([new Uint8Array([0xff])], 'bad.json'), snapshot)).rejects.toThrow();
});
test('offline packet verifier produces a bound printable copy without private console text', async ({}, info) => {
  test.setTimeout(120_000);
  const root = info.outputPath('packet-cli'), bundle = join(root, 'bundle');
  mkdirSync(root, { recursive: true });
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build',
    '--ssr', 'evaluation/verifyPacket.ts', '--outDir', bundle], { timeout: 60_000, stdio: 'pipe' });
  writeFileSync(join(bundle, 'package.json'), '{"type":"module"}\n');
  const packet = join(root, 'packet.json'), source = join(root, 'snapshot.json'), html = join(root, 'copy.html');
  const text = await serializeEvidencePacket(index, pins, corpora, entries, true);
  writeFileSync(packet, text); writeFileSync(source, snapshot);
  function run(output: string) {
    return spawnSync(process.execPath, [join(bundle, 'verifyPacket.js'), '--packet', packet, '--snapshot', source,
      '--html', output], { encoding: 'utf8', timeout: 20_000 });
  }
  const cli = join(bundle, 'verifyPacket.js');
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 20_000 });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('Usage: npm run verify:packet');
  expect(help.stderr).toBe('');
  const invalid = spawnSync(process.execPath, [cli, '--packet', 'private-fixture.json'],
    { encoding: 'utf8', timeout: 20_000 });
  expect(invalid.status).toBe(1);
  expect(invalid.stdout).toBe('');
  expect(invalid.stderr).toContain('Evidence packet verification failed');
  expect(invalid.stderr).not.toContain('private-fixture.json');
  expect(existsSync(html)).toBe(false);
  const success = run(html);
  expect(success.status, success.stderr).toBe(0);
  expect(JSON.parse(success.stdout)).toMatchObject({ consistent: true, authority_verified: false, entries: 2,
    packet_sha256: sha(text), snapshot_sha256: sha(snapshot) });
  expect(success.stdout).not.toContain('Application fee');
  const copy = readFileSync(html, 'utf8');
  expect(copy).toContain('&lt;script&gt;');
  const existing = run(html);
  expect(existing.status).toBe(1);
  expect(existing.stdout).toBe('');
  expect(existing.stderr).not.toContain('Application fee');
  expect(readFileSync(html, 'utf8')).toBe(copy);
  writeFileSync(packet, text.replace('INR 500', 'INR 900'));
  const tampered = run(join(root, 'bad.html'));
  expect(tampered.status).toBe(1);
  expect(tampered.stdout).toBe('');
  expect(tampered.stderr).not.toContain('INR 900');
  expect(existsSync(join(root, 'bad.html'))).toBe(false);
});
