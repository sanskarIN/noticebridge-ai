import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildIndex, type Corpus, type Passage } from '../src/pdfChatCore';
import { blankChecklistReviews, runChecklist, updateChecklistReview, type ChecklistPlan } from '../src/pdfChatChecklist';
import { serializeChecklistReport, serializeChecklistTemplate } from '../src/pdfChatChecklistExchange';
import { serializeCorpusSnapshot } from '../src/pdfChatCorpusSnapshot';
import { compareChecklistRuns } from '../src/pdfChatChecklistComparison';
import { prepareChecklistReadingCopy } from '../src/pdfChatChecklistReadingCopy';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const plan: ChecklistPlan = [
  { id: 'fee-private-id', question: 'Application fee?', scope: 'both', includeContext: false },
  { id: 'deadline-private-id', question: 'Application deadline?', scope: 'original', includeContext: false },
  { id: 'refund-private-id', question: 'Refund policy?', scope: 'both', includeContext: false },
];
const privateNote = 'Private reviewer annotation, not an answer.';
function corpus(passages: Passage[]): Corpus {
  return { passages, pageCount: 1, processedPages: 1, missingPages: [], limitedPages: [], limited: false };
}
async function fixture(revisedFee = 350, selected = plan) {
  const original = corpus([
    { role: 'original', page: 1, ordinal: 1, text: 'Application fee: INR 500' },
    { role: 'original', page: 1, ordinal: 2, text: 'Application deadline: 19 December 2026' },
  ]);
  const revised = corpus([{ role: 'revised', page: 1, ordinal: 1, text: 'Application fee: INR ' + revisedFee }]);
  const sources = { original, revised };
  const pins = { original: 'a'.repeat(64), revised: (revisedFee === 350 ? 'b' : 'c').repeat(64) };
  const index = buildIndex([...original.passages, ...revised.passages]);
  const reviews = updateChecklistReview(selected, blankChecklistReviews(selected), 'fee-private-id', {
    status: 'reviewed_manually', note: privateNote,
  });
  return {
    snapshot: serializeCorpusSnapshot(pins, sources),
    report: await serializeChecklistReport(index, pins, sources, selected, reviews,
      runChecklist(index, sources, selected), true),
  };
}
function buildCli(root: string, entry: 'verifyChecklist' | 'compareChecklist') {
  const bundle = join(root, entry);
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build',
    '--ssr', 'evaluation/' + entry + '.ts', '--outDir', bundle], { timeout: 60_000, stdio: 'pipe' });
  writeFileSync(join(bundle, 'package.json'), '{"type":"module"}\n');
  return (args: string[]) => spawnSync(process.execPath, [join(bundle, entry + '.js'), ...args], {
    encoding: 'utf8', timeout: 30_000,
  });
}
function writeFixture(root: string, prefix: string, input: { report: string; snapshot: string }) {
  const report = join(root, prefix + '-report.json');
  const snapshot = join(root, prefix + '-snapshot.json');
  writeFileSync(report, input.report);
  writeFileSync(snapshot, input.snapshot);
  return { report, snapshot };
}
function assertPrivate(output: string, path: string) {
  for (const text of [privateNote, 'Application fee', 'Refund policy', 'INR 500', 'fee-private-id', path]) {
    expect(output).not.toContain(text);
  }
}

test('offline verifier checks canonical inputs and creates exclusive HTML or CSV derivatives', async ({}, info) => {
  test.setTimeout(120_000);
  const root = info.outputPath('checklist-verifier-cli');
  mkdirSync(root, { recursive: true });
  const run = buildCli(root, 'verifyChecklist');
  const input = await fixture();
  const files = writeFixture(root, 'private', input);
  const args = ['--report', files.report, '--snapshot', files.snapshot];
  const html = join(root, 'reading.html'), csv = join(root, 'reading.csv');
  const help = run(['--help']);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('verify:checklist');
  const verified = run(args);
  expect(verified.status, verified.stderr).toBe(0);
  expect(JSON.parse(verified.stdout)).toMatchObject({
    consistent: true, authority_verified: false,
    report_sha256: sha(input.report), snapshot_sha256: sha(input.snapshot),
    summary: { questions: 3, citations: 3, reviewed: 1 }, reading_copy: null,
  });
  assertPrivate(verified.stdout + verified.stderr, root);
  for (const [format, path] of [['html', html], ['csv', csv]] as const) {
    const copy = run([...args, '--' + format, path]);
    expect(copy.status, copy.stderr).toBe(0);
    expect(JSON.parse(copy.stdout).reading_copy).toBe(format);
    const expected = await prepareChecklistReadingCopy(input.report, input.snapshot, format);
    expect(readFileSync(path, 'utf8')).toBe(expected.text);
    assertPrivate(copy.stdout + copy.stderr, root);
    expect(run([...args, '--' + format, path]).status).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(expected.text);
  }
  expect(run([...args, '--html', html, '--csv', csv]).status).toBe(1);
  expect(run([...args, '--html', join(root, 'bad.json')]).status).toBe(1);
  expect(run([...args, '--report', files.report]).status).toBe(1);
  expect(run(['--report', files.report]).status).toBe(1);
  expect(run([...args, '--unknown', 'x']).status).toBe(1);
  const unavailable = join(root, 'missing', 'copy.html');
  expect(run([...args, '--html', unavailable]).status).toBe(1);
  expect(existsSync(unavailable)).toBe(false);
  const bad = join(root, 'bad.html');
  writeFileSync(files.report, input.report.replace('INR 500', 'INR 999'));
  const rejected = run([...args, '--html', bad]);
  expect(rejected.status).toBe(1);
  expect(rejected.stdout).toBe('');
  assertPrivate(rejected.stderr, root);
  expect(existsSync(bad)).toBe(false);
  writeFileSync(files.report, input.report);
  writeFileSync(files.snapshot, input.snapshot + ' ');
  expect(run(args).status).toBe(1);
  writeFileSync(files.snapshot, Buffer.from([0xff, 0xfe]));
  expect(run(args).status).toBe(1);
});
test('offline comparison command replays both inputs and refuses stale, incomparable or pre-existing output', async ({}, info) => {
  test.setTimeout(120_000);
  const root = info.outputPath('checklist-comparison-cli');
  mkdirSync(root, { recursive: true });
  const run = buildCli(root, 'compareChecklist');
  const left = await fixture(), right = await fixture(250);
  const a = writeFixture(root, 'first-private', left), b = writeFixture(root, 'second-private', right);
  const output = join(root, 'comparison.json');
  const args = ['--left-report', a.report, '--left-snapshot', a.snapshot,
    '--right-report', b.report, '--right-snapshot', b.snapshot, '--output', output];
  expect(run(['--help']).status).toBe(0);
  const result = run(args);
  expect(result.status, result.stderr).toBe(0);
  const expected = await compareChecklistRuns(left, right);
  expect(readFileSync(output, 'utf8')).toBe(expected.text);
  expect(JSON.parse(result.stdout)).toMatchObject({
    consistent: true, verified_replay: false, authority_verified: false,
    left: { report_sha256: sha(left.report), snapshot_sha256: sha(left.snapshot) },
    right: { report_sha256: sha(right.report), snapshot_sha256: sha(right.snapshot) },
    summary: { questions: 3, changed_questions: 2 },
  });
  assertPrivate(result.stdout + result.stderr, root);
  const replay = run([...args, '--verify']);
  expect(replay.status, replay.stderr).toBe(0);
  expect(JSON.parse(replay.stdout).verified_replay).toBe(true);
  assertPrivate(replay.stdout + replay.stderr, root);
  expect(run(args).status).toBe(1);
  expect(readFileSync(output, 'utf8')).toBe(expected.text);
  expect(run([...args, '--verify', '--verify']).status).toBe(1);
  expect(run([...args, '--output', output]).status).toBe(1);
  expect(run(args.slice(0, -2)).status).toBe(1);
  writeFileSync(output, expected.text.replace('"authority_verified": false', '"authority_verified": true'));
  expect(run([...args, '--verify']).status).toBe(1);
  expect(readFileSync(output, 'utf8')).toContain('"authority_verified": true');
  writeFileSync(output, expected.text);
  writeFileSync(b.snapshot, right.snapshot.replace('INR 250', 'INR 251'));
  const failed = run([...args, '--verify']);
  expect(failed.status).toBe(1);
  expect(failed.stdout).toBe('');
  assertPrivate(failed.stderr, root);
  expect(readFileSync(output, 'utf8')).toBe(expected.text);
  const changed = await fixture(250, plan.map(row => row.id === 'fee-private-id'
    ? { ...row, scope: 'revised' } : row));
  writeFileSync(b.report, changed.report);
  writeFileSync(b.snapshot, changed.snapshot);
  const missing = join(root, 'incomparable.json');
  expect(run([...args.slice(0, -1), missing]).status).toBe(1);
  expect(existsSync(missing)).toBe(false);
});

async function openComparison(page: Page) {
  await page.goto('/?view=chat');
  const panel = page.locator('details.chat-checklist-comparison');
  await panel.locator('summary').click();
  return panel;
}
async function selectPair(page: Page, side: 'First' | 'Second', input: { report: string; snapshot: string }) {
  const panel = page.locator('details.chat-checklist-comparison');
  await panel.getByLabel(side + ' checklist report JSON').setInputFiles({
    name: 'report.json', mimeType: 'application/json', buffer: Buffer.from(input.report),
  });
  await panel.getByLabel(side + ' native snapshot JSON').setInputFiles({
    name: 'snapshot.json', mimeType: 'application/json', buffer: Buffer.from(input.snapshot),
  });
}
test('browser compares and verifies saved local runs without PDF attachments or remote calls', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
  const panel = await openComparison(page);
  const left = await fixture(), right = await fixture(250);
  const compare = panel.getByRole('button', { name: 'Compare saved checklists' });
  const verify = panel.getByRole('button', { name: 'Verify saved comparison' });
  await expect(compare).toBeDisabled();
  await selectPair(page, 'First', left);
  await expect(compare).toBeDisabled();
  await selectPair(page, 'Second', right);
  await expect(compare).toBeEnabled();
  await expect(verify).toBeDisabled();
  await compare.click();
  const results = panel.getByRole('region', { name: 'Saved checklist comparison results' });
  await expect(results.getByRole('heading', { name: 'Both checklist runs replayed' })).toBeVisible();
  await expect(results.locator('.chat-checklist-result')).toHaveCount(2);
  const fee = results.getByRole('article', { name: 'Observation comparison fee-private-id' });
  await expect(fee.getByText('Source fingerprint or coverage changed')).toBeVisible();
  await expect(fee.getByText('Unchanged retrieval observation')).toBeVisible();
  await results.getByLabel('Show only different observations').uncheck();
  await expect(results.locator('.chat-checklist-result')).toHaveCount(3);
  await expect(results.getByRole('article', { name: 'Observation comparison deadline-private-id' })).toBeVisible();
  await results.getByText('Exact input fingerprints and source coverage').click();
  await expect(results.getByText(sha(left.report), { exact: true })).toBeVisible();
  await expect(results.getByText(sha(right.snapshot), { exact: true })).toBeVisible();
  const exportButton = results.getByRole('button', { name: 'Export checklist comparison' });
  await expect(exportButton).toBeDisabled();
  await results.getByLabel('I approve exporting private comparison identifiers and fingerprints.').check();
  const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
  const data = await readFile((await download.path())!);
  expect(data.toString('utf8')).toBe((await compareChecklistRuns(left, right)).text);
  expect(data.toString('utf8')).not.toContain(privateNote);
  await panel.getByLabel('Existing checklist comparison JSON (optional)').setInputFiles({
    name: 'comparison.json', mimeType: 'application/json', buffer: data,
  });
  await expect(results).toHaveCount(0);
  await verify.click();
  await expect(results.getByRole('heading', { name: 'Saved comparison replay verified' })).toBeVisible();
  await expect(exportButton).toBeDisabled();
  await expect(page.locator('.chat-turn')).toHaveCount(0);
  expect(requests).toEqual([]);
});
test('comparison panel clears old results and rejects stale or malformed local inputs', async ({ page }) => {
  const panel = await openComparison(page);
  const left = await fixture(), right = await fixture(250);
  const compare = panel.getByRole('button', { name: 'Compare saved checklists' });
  const results = panel.getByRole('region', { name: 'Saved checklist comparison results' });
  await selectPair(page, 'First', left);
  await selectPair(page, 'Second', right);
  await compare.click();
  await expect(results).toBeVisible();
  await panel.getByLabel('Second native snapshot JSON').setInputFiles({
    name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(left.snapshot),
  });
  await expect(results).toHaveCount(0);
  await compare.click();
  await expect(panel.getByRole('alert')).toContainText('Comparison rejected');
  await expect(results).toHaveCount(0);
  await panel.getByLabel('Second native snapshot JSON').setInputFiles({
    name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from([0xff]),
  });
  await compare.click();
  await expect(panel.getByRole('alert')).toContainText('Comparison rejected');
  await panel.getByRole('button', { name: 'Clear comparison inputs and results' }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(compare).toBeDisabled();
  await expect(panel.getByText('No file selected', { exact: true })).toHaveCount(5);
});
test('comparison browser rejects a valid report with different questions and a tampered comparison', async ({ page }) => {
  const panel = await openComparison(page);
  const left = await fixture(), right = await fixture(250);
  await selectPair(page, 'First', left);
  const changed = await fixture(250, plan.map(row => row.id === 'fee-private-id'
    ? { ...row, includeContext: true } : row));
  await selectPair(page, 'Second', changed);
  await panel.getByRole('button', { name: 'Compare saved checklists' }).click();
  await expect(panel.getByRole('alert')).toContainText('Comparison rejected');
  await selectPair(page, 'Second', right);
  const output = await compareChecklistRuns(left, right);
  await panel.getByLabel('Existing checklist comparison JSON (optional)').setInputFiles({
    name: 'comparison.json', mimeType: 'application/json',
    buffer: Buffer.from(output.text.replace('"authority_verified": false', '"authority_verified": true')),
  });
  await panel.getByRole('button', { name: 'Verify saved comparison' }).click();
  await expect(panel.getByRole('alert')).toContainText('Comparison rejected');
  await expect(panel.getByRole('region', { name: 'Saved checklist comparison results' })).toHaveCount(0);
});
test('reusable template imports require confirmation, never import old notes, and reject forged question fields', async ({ page }) => {
  await page.goto('/?view=chat');
  await page.getByRole('button', { name: 'Try fictional notices' }).click();
  await expect(page.getByText(/extracted passages available/)).toHaveCount(2);
  const panel = page.locator('details.chat-checklist');
  await panel.locator('summary').click();
  const template = serializeChecklistTemplate(plan, true);
  await panel.getByLabel('Import checklist template').setInputFiles({
    name: 'template.json', mimeType: 'application/json', buffer: Buffer.from(template),
  });
  const confirmation = panel.getByRole('region', { name: 'Checklist import confirmation' });
  await expect(confirmation).toBeVisible();
  await expect(panel.getByText('0/40 checklist questions')).toBeVisible();
  await panel.getByRole('button', { name: 'Cancel checklist import' }).click();
  await expect(confirmation).toHaveCount(0);
  await panel.getByLabel('Import checklist template').setInputFiles({
    name: 'template.json', mimeType: 'application/json', buffer: Buffer.from(template),
  });
  await panel.getByRole('button', { name: 'Apply imported checklist' }).click();
  await expect(panel.getByText('3/40 checklist questions')).toBeVisible();
  await expect(panel.locator('.chat-checklist-result')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Run question checklist' }).click();
  await expect(panel.locator('.chat-checklist-result')).toHaveCount(3);
  await expect(panel.getByLabel('Review status for fee-private-id')).toHaveValue('unreviewed');
  await expect(panel.getByLabel('Personal note for fee-private-id')).toHaveValue('');
  const forged = template.replace('"authority_verified": false', '"authority_verified": true');
  await panel.getByLabel('Import checklist template').setInputFiles({
    name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(forged),
  });
  await expect(panel.getByRole('alert')).toContainText('Template rejected');
  await expect(panel.locator('.chat-checklist-result')).toHaveCount(3);
});
