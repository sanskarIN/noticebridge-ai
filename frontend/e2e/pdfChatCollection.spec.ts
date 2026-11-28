import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { collectionPdf } from './helpers/collectionPdf';

function fixture(name: string, pages: string[][]) {
  return { name, mimeType: 'application/pdf', buffer: collectionPdf(pages) };
}
async function open(page: Page) {
  await page.goto('/?view=chat');
  await page.getByText('Search an independent PDF collection (up to six documents)', { exact: true }).click();
  return page.getByRole('region', { name: 'Independent PDF collection', exact: true });
}
async function attach(page: Page, fixtures: ReturnType<typeof fixture>[], count: number) {
  const root = page.getByRole('region', { name: 'Independent PDF collection', exact: true });
  await root.getByLabel('Attach collection PDFs').setInputFiles(fixtures);
  await expect(root.getByLabel('Collection processing budget')).toContainText(count + ' / 6');
  await expect(root.getByLabel('Collection attachment result')).toBeVisible();
  await expect(root.getByText(/Indexing collection PDF/)).toHaveCount(0);
  return root;
}
async function ask(page: Page, question: string) {
  const root = page.getByRole('region', { name: 'Independent PDF collection', exact: true });
  await root.getByLabel('Collection question', { exact: true }).fill(question);
  await root.getByRole('button', { name: 'Ask collection', exact: true }).click();
  return root.getByLabel('Collection results');
}

test('collection independently searches three real PDFs with exact sources and no API requests', async ({ page }) => {
  const api: string[] = [];
  await page.route('**/api/**', route => { api.push(route.request().url()); return route.abort(); });
  const root = await open(page);
  await attach(page, [
    fixture('notice.pdf', [['Application fee: INR 500']]),
    fixture('notice.pdf', [['Application fee: INR 350']]),
    fixture('eligibility.pdf', [['Eligibility: Class 12']]),
  ], 3);
  const result = await ask(page, 'Application fee?');
  await expect(result.locator('blockquote')).toHaveText(['Application fee: INR 500', 'Application fee: INR 350']);
  const third = result.getByRole('region', { name: 'Collection result: Document 3: eligibility.pdf' });
  await expect(third).toContainText('No matching indexed evidence');
  const second = result.getByRole('region', { name: 'Collection result: Document 2: notice.pdf' });
  await second.getByRole('button', { name: 'Inspect collection source [1]' }).click();
  const inspection = root.getByRole('region', { name: 'Collection source inspection' });
  await expect(inspection.locator('blockquote')).toHaveText('Application fee: INR 350');
  await expect(inspection.getByText('Source page shown for manual inspection.')).toBeVisible();
  await expect(inspection.locator('canvas')).toBeVisible();
  await inspection.getByRole('button', { name: 'Close collection source' }).click();
  await expect(inspection).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ask PDF', exact: true })).toBeDisabled();
  expect(api).toEqual([]);
});
test('explicit selection and physical page scope never substitute a different PDF or page', async ({ page }) => {
  await open(page);
  const root = await attach(page, [
    fixture('two-pages.pdf', [['Application fee: INR 500'], ['Application fee: INR 250']]),
    fixture('one-page.pdf', [['Application fee: INR 350']]),
  ], 2);
  await root.getByLabel('Search document 2', { exact: true }).uncheck();
  const selected = await ask(page, 'Application fee on page 2?');
  await expect(selected.locator('blockquote')).toHaveText('Application fee: INR 250');
  await expect(selected.getByRole('region')).toHaveCount(1);
  await root.getByRole('button', { name: 'Select all collection PDFs' }).click();
  const both = await ask(page, 'Application fee on page 2?');
  await expect(both.locator('blockquote')).toHaveText('Application fee: INR 250');
  await expect(both.getByRole('region', { name: 'Collection result: Document 2: one-page.pdf' }))
    .toContainText('This physical page does not exist');
  await root.getByLabel('View collection question').selectOption('0');
  await expect(root.getByLabel('Collection results').getByRole('region')).toHaveCount(1);
  await root.getByRole('button', { name: 'Copy this collection question' }).click();
  await expect(root.getByLabel('Collection question', { exact: true })).toHaveValue('Application fee on page 2?');
  await expect(root.getByLabel('Search document 2', { exact: true })).not.toBeChecked();
});
test('duplicates are rejected by bytes while same-name different documents are admitted', async ({ page }) => {
  await open(page);
  const root = await attach(page, [
    fixture('same.pdf', [['Application fee: INR 500']]),
    fixture('renamed.pdf', [['Application fee: INR 500']]),
    fixture('same.pdf', [['Application fee: INR 350']]),
  ], 2);
  await expect(root.getByLabel('Collection attachment result')).toContainText('2 collection PDF(s) accepted');
  await expect(root.getByLabel('Collection attachment result')).toContainText('exact PDF bytes are already');
  await expect((await ask(page, 'Application fee?')).locator('blockquote'))
    .toHaveText(['Application fee: INR 500', 'Application fee: INR 350']);
});
test('removal requires confirmation and clears stale results without changing the primary chat', async ({ page }) => {
  const root = await open(page);
  await attach(page, [
    fixture('first.pdf', [['Application fee: INR 500']]),
    fixture('second.pdf', [['Application fee: INR 350']]),
  ], 2);
  const result = await ask(page, 'Application fee?');
  await result.getByRole('region', { name: 'Collection result: Document 1: first.pdf' })
    .getByRole('button', { name: 'Inspect collection source [1]' }).click();
  await root.getByRole('button', { name: 'Remove document 1' }).click();
  await expect(root.getByLabel('Remove collection document confirmation')).toBeVisible();
  await root.getByRole('button', { name: 'Keep document' }).click();
  await expect(root.getByLabel('Collection results').locator('blockquote')).toHaveCount(2);
  await root.getByRole('button', { name: 'Remove document 1' }).click();
  await root.getByRole('button', { name: 'Confirm document removal' }).click();
  await expect(root.getByLabel('Collection conversation')).toHaveCount(0);
  await expect(root.getByRole('region', { name: 'Collection source inspection' })).toHaveCount(0);
  await expect(root.getByLabel('Collection processing budget')).toContainText('1 / 6');
  await expect((await ask(page, 'Application fee?')).locator('blockquote')).toHaveText('Application fee: INR 350');
});
test('question plan and evidence report require separate consent and restore only on confirmation', async ({ page }) => {
  const root = await open(page);
  await attach(page, [
    fixture('private-A.pdf', [['Application fee: INR 500']]),
    fixture('private-B.pdf', [['Application fee: INR 350']]),
  ], 2);
  await ask(page, 'Application fee?');
  await root.getByText('Save or verify private collection work', { exact: true }).click();
  const planButton = root.getByRole('button', { name: 'Export collection question plan' });
  const reportButton = root.getByRole('button', { name: 'Export collection evidence report' });
  await expect(planButton).toBeDisabled();
  await expect(reportButton).toBeDisabled();
  await root.getByLabel('I approve exporting private collection questions and fingerprints.').check();
  const planEvent = page.waitForEvent('download');
  await planButton.click();
  const plan = await planEvent;
  const planBytes = await readFile((await plan.path())!);
  expect(planBytes.toString()).not.toContain('INR 500');
  expect(planBytes.toString()).not.toContain('private-A.pdf');
  await expect(planButton).toBeDisabled();
  await expect(reportButton).toBeDisabled();
  await root.getByLabel('I approve exporting private collection excerpts and questions.').check();
  const reportEvent = page.waitForEvent('download');
  await reportButton.click();
  const report = await reportEvent;
  const reportBytes = await readFile((await report.path())!);
  expect(reportBytes.toString()).toContain('INR 500');
  expect(reportBytes.toString()).not.toContain('private-A.pdf');
  await root.getByRole('button', { name: 'Clear collection questions' }).click();
  await root.getByLabel('Import collection question plan').setInputFiles({
    name: 'plan.json', mimeType: 'application/json', buffer: planBytes,
  });
  await expect(root.getByLabel('Collection question restore confirmation')).toBeVisible();
  await expect(root.getByLabel('Collection conversation')).toHaveCount(0);
  await root.getByRole('button', { name: 'Apply saved collection questions' }).click();
  await expect(root.getByLabel('Collection results').locator('blockquote'))
    .toHaveText(['Application fee: INR 500', 'Application fee: INR 350']);
  await root.getByLabel('Verify collection evidence report').setInputFiles({
    name: 'report.json', mimeType: 'application/json', buffer: reportBytes,
  });
  await expect(root.getByText(/Exact collection evidence replay matched 1 question/)).toBeVisible();
  await expect(root.getByLabel('Collection results').locator('blockquote')).toHaveCount(2);
});
test('narrow collection layout keeps search usable and does not overflow the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  const root = await open(page);
  await attach(page, [fixture('a-very-long-private-document-name-for-layout.pdf', [['Application fee: INR 500']])], 1);
  await expect((await ask(page, 'Application fee?')).locator('blockquote')).toHaveText('Application fee: INR 500');
  await root.getByText('Source SHA-256', { exact: true }).click();
  const width = await root.evaluate(element => ({
    scroll: element.scrollWidth, client: element.clientWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.client + 2);
});

test('field matrix shows distinct literal values, retains coverage and can prefill a question', async ({ page }) => {
  const root = await open(page);
  await attach(page, [
    fixture('first.pdf', [['Application fee: INR 500', 'Eligibility: Class 12']]),
    fixture('second.pdf', [['Application fee: INR 350', 'Eligibility: Class 12']]),
    fixture('third.pdf', [['Eligibility: Class 12']]),
  ], 3);
  await root.getByText('Compare recognized printed fields across selected collection PDFs', { exact: true }).click();
  const matrix = root.locator('details').filter({ has: root.getByText('Compare recognized printed fields across selected collection PDFs', { exact: true }) });
  await matrix.getByLabel('Find collection field').fill('fee');
  await expect(matrix.getByText('No recognized field in one or more selected documents.')).toBeVisible();
  await expect(matrix.getByText('INR 500', { exact: true })).toBeVisible();
  await expect(matrix.getByText('INR 350', { exact: true })).toBeVisible();
  await expect(matrix.getByText('No recognized indexed value.', { exact: true })).toHaveCount(1);
  await matrix.getByRole('region', { name: 'Printed field: Document 2: second.pdf' })
    .getByRole('button', { name: 'Inspect collection field page 1' }).click();
  const source = root.getByRole('region', { name: 'Collection source inspection' });
  await expect(source.locator('blockquote')).toHaveText('Application fee: INR 350');
  await source.getByRole('button', { name: 'Close collection source' }).click();
  await matrix.getByLabel('Find collection field').fill('eligibility');
  await expect(matrix.getByText('Same single literal value in all selected documents.')).toBeVisible();
  await matrix.getByLabel('Collection field filter').selectOption('review');
  await expect(matrix.getByText('No recognized fields match this filter.')).toBeVisible();
  await matrix.getByLabel('Find collection field').fill('fee');
  await matrix.getByRole('button', { name: /Ask collection about.*fee/i }).click();
  await expect(root.getByLabel('Collection question', { exact: true })).toHaveValue(/fee/i);
  await expect(root.getByLabel('Collection conversation')).toHaveCount(0);
});

test('collection literal search keeps physical page coverage and exact document identity', async ({ page }) => {
  const root = await open(page);
  await attach(page, [
    fixture('two-pages.pdf', [['Application fee: INR 500'], ['Application fee: INR 250']]),
    fixture('one-page.pdf', [['Application fee: INR 350']]),
  ], 2);
  await root.getByText('Explore exact text and references across collection PDFs', { exact: true }).click();
  await root.getByLabel('Collection evidence search text').fill('application fee');
  await root.getByLabel('Collection evidence physical page (optional)').fill('2');
  await root.getByRole('button', { name: 'Search collection evidence', exact: true }).click();
  const results = root.getByLabel('Collection evidence search results');
  await expect(results.locator('mark')).toHaveText('Application fee');
  const first = results.getByRole('region', { name: 'Collection evidence: Document 1: two-pages.pdf' });
  await expect(first).toContainText('INR 250');
  await expect(first).not.toContainText('INR 500');
  await expect(results.getByRole('region', { name: 'Collection evidence: Document 2: one-page.pdf' }))
    .toContainText('Physical page does not exist.');
  await first.getByRole('button', { name: /Inspect collection evidence page 2/ }).click();
  await expect(root.getByRole('region', { name: 'Collection source inspection' }).locator('blockquote'))
    .toHaveText('Application fee: INR 250');
  await root.getByRole('button', { name: 'Close collection source' }).click();
  await root.getByLabel('Search document 2', { exact: true }).uncheck();
  await expect(results).toHaveCount(0);
  await expect(root.getByLabel('Collection conversation')).toHaveCount(0);
});

test('explicit references and case-sensitive phrases do not silently broaden the search', async ({ page }) => {
  const root = await open(page);
  await attach(page, [
    fixture('references.pdf', [['Clause 4.2: Eligibility', 'Clause 4.20: Different provision']]),
    fixture('mentions.pdf', [['See clause 4.2 for details']]),
  ], 2);
  await root.getByText('Explore exact text and references across collection PDFs', { exact: true }).click();
  await root.getByLabel('Collection evidence mode').selectOption('reference');
  await root.getByLabel('Collection evidence search text').fill('Clause 4.2');
  await root.getByRole('button', { name: 'Search collection evidence', exact: true }).click();
  const results = root.getByLabel('Collection evidence search results');
  await expect(results.locator('mark')).toHaveCount(2);
  await expect(results).not.toContainText('Different provision');
  await expect(results.getByText(/Fragment starts with reference/)).toHaveCount(1);
  await expect(results.getByText(/Reference appears within fragment/)).toHaveCount(1);
  await root.getByLabel('Collection evidence mode').selectOption('literal');
  await root.getByLabel('Collection evidence search text').fill('Clause 4.2:');
  await root.getByLabel('Ignore ASCII case in collection evidence').uncheck();
  await root.getByRole('button', { name: 'Search collection evidence', exact: true }).click();
  await expect(results.locator('mark')).toHaveText('Clause 4.2:');
  await root.getByLabel('Collection evidence physical page (optional)').fill('0');
  await root.getByRole('button', { name: 'Search collection evidence', exact: true }).click();
  await expect(root.getByText(/Enter a valid literal phrase or explicit reference/)).toBeVisible();
  await expect(results).toHaveCount(0);
});

test('expanding strict question matches exposes additional pages without changing citations', async ({ page }) => {
  const root = await open(page);
  const pages = Array.from({ length: 14 }, (_, i) => ['Application fee: INR ' + (100 + i)]);
  await attach(page, [fixture('fees.pdf', pages)], 1);
  const answer = await ask(page, 'Application fee?');
  const before = await answer.locator('blockquote').allTextContents();
  expect(before.length).toBeGreaterThan(0);
  expect(before.length).toBeLessThan(14);
  await answer.getByRole('button', { name: 'Show all collection question matches' }).click();
  await expect(answer.getByText('14 indexed fragment match(es).')).toBeVisible();
  await expect(answer.getByRole('button', { name: /Inspect collection evidence page/ })).toHaveCount(12);
  await answer.getByRole('button', { name: 'Next collection matches' }).click();
  await expect(answer.getByRole('button', { name: /Inspect collection evidence page/ })).toHaveCount(2);
  await expect(answer.getByRole('button', { name: 'Next collection matches' })).toBeDisabled();
  expect(await answer.locator('blockquote').allTextContents()).toEqual(before);
  await answer.getByRole('button', { name: 'Previous collection matches' }).click();
  await expect(answer.getByRole('button', { name: /Inspect collection evidence page/ })).toHaveCount(12);
  await answer.getByRole('button', { name: 'Hide all collection question matches' }).click();
  await expect(answer.getByRole('button', { name: /Inspect collection evidence page/ })).toHaveCount(0);
  await expect(root.getByLabel('View collection question').locator('option')).toHaveCount(1);
});
