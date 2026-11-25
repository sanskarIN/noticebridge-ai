import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';

const execute = promisify(execFile);
const repository = resolve(process.cwd(), '..');

type IndexRow = {
  case: number;
  report: string;
  report_sha256: string;
};
type BatchIndex = {
  manifest_sha256: string;
  complete: boolean;
  case_count: number;
  completed_count: number;
  cases: IndexRow[];
};

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function python(args: string[]) {
  const run = await execute('python', args, {
    cwd: repository,
    timeout: 90_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(run.stdout);
}

let root: string;
let demo: string;
let manifest: string;
let batch: string;
let indexFile: string;
let index: BatchIndex;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  root = await mkdtemp(join(tmpdir(), 'noticebridge-browser-batch-'));
  demo = join(root, 'fictional');
  const result = await python([
    'backend/benchmarks/generate_batch_fixture.py', '--output', demo,
  ]);
  expect(result.synthetic).toBe(true);
  expect(result.case_count).toBe(3);
  expect(result.authority_verified).toBe(false);
  manifest = join(demo, 'manifest.json');
  batch = join(demo, 'batch');
  indexFile = join(batch, 'index.json');
  index = JSON.parse((await readFile(indexFile)).toString());
});

test.afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function loadBatch(page: Page) {
  await page.goto('/?view=batch');
  await page.getByLabel('Batch index (up to 128 KiB)').setInputFiles(indexFile);
  await expect(page.getByRole('heading', { name: '2. Saved batch summary' })).toBeVisible();
  await page.getByLabel('Pinned manifest JSON (up to 64 KiB)').setInputFiles(manifest);
  await expect(page.getByText(/Manifest bytes and listed source pins match/)).toBeVisible();
}

async function loadCase(page: Page, number: number) {
  await page.getByRole('button', { name: 'Case ' + number + ' details', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Case ' + number, exact: true })).toBeVisible();
  await page.getByLabel('Select saved case report (up to 8 MiB)').setInputFiles(
    join(batch, index.cases[number - 1].report),
  );
  await expect(page.getByText(/Report bytes match the saved digest/)).toBeVisible();
}

async function exportLedger(page: Page, path: string) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export review ledger JSON' }).click();
  await (await download).saveAs(path);
  return JSON.parse((await readFile(path)).toString());
}

test('actual Python batch opens all three case reports with no API requests', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/api/**', route => {
    requests.push(route.request().url());
    return route.abort();
  });
  await loadBatch(page);
  expect(index.complete).toBe(true);
  await expect(page.getByText(/3 of 3 cases saved/)).toBeVisible();
  for (const number of [1, 2, 3]) {
    await loadCase(page, number);
  }
  expect(requests).toEqual([]);
});

test('real partial extraction case remains visible in coverage filter', async ({ page }) => {
  await loadBatch(page);
  await page.getByLabel('Text coverage filter').selectOption('limited');
  await expect(page.getByRole('button', { name: 'Case 2 details' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Case 1 details' })).toHaveCount(0);
  await loadCase(page, 2);
  await expect(page.getByText('Partial text coverage', { exact: true })).toBeVisible();
});

test('actual deadline and fee evidence can be inspected on the matching source PDF', async ({ page }) => {
  await loadBatch(page);
  await loadCase(page, 1);
  await expect(page.getByText('Application deadline: 13 December 2026', { exact: true })).toBeVisible();
  await expect(page.getByText('Application fee: Rs. 500', { exact: true })).toBeVisible();
  await page.getByLabel('Original notice PDF for this case').setInputFiles(
    join(demo, 'case-001-original.pdf'),
  );
  await expect(page.getByText('Original notice PDF bytes match the saved fingerprint.')).toBeVisible();
  const finding = page.locator('.batch-finding').filter({
    hasText: 'Application deadline: 13 December 2026',
  });
  await finding.getByRole('button', { name: 'Inspect original notice page 1' }).click();
  await expect(page.locator('.batch-page-panel .evidence-highlight')).toBeVisible();
});

test('real same-page contradiction exposes two updated source quotations', async ({ page }) => {
  await loadBatch(page);
  await loadCase(page, 3);
  await page.getByLabel('Saved finding type').selectOption('contradiction');
  const findings = page.locator('.batch-finding');
  await expect(findings.first()).toBeVisible();
  await expect(findings.first().getByText('Application deadline: 14 December 2026')).toBeVisible();
  await expect(findings.first().getByText('Application deadline: 16 December 2026')).toBeVisible();
  await expect(findings.first().getByRole('heading', { name: 'Updated notice' })).toHaveCount(2);
});

test('changing cases clears attached PDF bytes and report preview', async ({ page }) => {
  await loadBatch(page);
  await loadCase(page, 1);
  await page.getByLabel('Original notice PDF for this case').setInputFiles(
    join(demo, 'case-001-original.pdf'),
  );
  await expect(page.getByText('1 of 2 PDF fingerprints matched.')).toBeVisible();
  await page.getByRole('button', { name: 'Case 2 details' }).click();
  await expect(page.getByText('0 of 2 PDF fingerprints matched.')).toBeVisible();
  await expect(page.getByText(/Report bytes match the saved digest/)).toHaveCount(0);
});

test('browser ledger is accepted by the real Python structural audit', async ({ page }) => {
  test.setTimeout(90_000);
  await loadBatch(page);
  await page.getByLabel('Review state for case 1').selectOption('reviewed');
  await page.getByLabel('Review state for case 2').selectOption('follow_up');
  const path = join(root, 'browser-ledger.json');
  const ledger = await exportLedger(page, path);
  expect(ledger.index_sha256).toBe(sha256(await readFile(indexFile)));
  expect(ledger.manifest_sha256).toBe(index.manifest_sha256);
  const result = await python([
    '-m', 'noticebridge.batch_review', 'inspect', manifest,
    '--batch', batch, '--first', path,
  ]);
  expect(result.human_review_counts).toEqual({
    unreviewed: 1, reviewed: 1, follow_up: 1, in_progress: 0,
  });
  expect(result.authority_verified).toBe(false);
  expect(result.engine_replayed).toBe(false);
});

test('Python reconciles browser ledgers and the browser restores the merged markers', async ({ page }) => {
  test.setTimeout(120_000);
  await loadBatch(page);
  await page.getByLabel('Review state for case 1').selectOption('reviewed');
  await page.getByLabel('Review state for case 2').selectOption('in_progress');
  const first = join(root, 'reviewer-one.json');
  await exportLedger(page, first);
  await loadBatch(page);
  await page.getByLabel('Review state for case 1').selectOption('follow_up');
  await page.getByLabel('Review state for case 3').selectOption('reviewed');
  const second = join(root, 'reviewer-two.json');
  await exportLedger(page, second);
  const base = [manifest, '--batch', batch, '--first', first, '--second', second];
  const resolution = join(root, 'resolution.json');
  const result = await python([
    '-m', 'noticebridge.batch_review', 'compare', ...base, '--template', resolution,
  ]);
  expect(result.conflicts).toEqual([{ case: 1, first: 'reviewed', second: 'follow_up' }]);
  const plan = JSON.parse((await readFile(resolution)).toString());
  expect(plan.resolutions).toEqual([{ case: 1, state: null }]);
  plan.resolutions[0].state = 'follow_up';
  await writeFile(resolution, JSON.stringify(plan));
  const combined = join(root, 'combined.json');
  const merged = await python([
    '-m', 'noticebridge.batch_review', 'merge', ...base,
    '--resolution', resolution, '--output', combined,
  ]);
  expect(merged.human_review_counts).toEqual({
    unreviewed: 0, reviewed: 1, follow_up: 1, in_progress: 1,
  });
  await page.getByLabel('Restore review ledger JSON').setInputFiles(combined);
  await expect(page.getByRole('region', { name: 'Review restore confirmation' })).toBeVisible();
  await page.getByRole('button', { name: 'Apply saved markers' }).click();
  await expect(page.getByLabel('Review state for case 1')).toHaveValue('follow_up');
  await expect(page.getByLabel('Review state for case 2')).toHaveValue('in_progress');
  await expect(page.getByLabel('Review state for case 3')).toHaveValue('reviewed');
});
