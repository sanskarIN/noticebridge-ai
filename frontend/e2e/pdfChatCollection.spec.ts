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
