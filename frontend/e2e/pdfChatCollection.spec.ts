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
  await root.getByRole('button', { name: 'Select all collection PDFs', exact: true }).click();
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
  const matrix = root.getByRole('group', { name: 'Compare recognized printed fields across selected collection PDFs', exact: true });
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

test('collection evidence review retains exact document identities and survives clearing questions', async ({ page }) => {
  const root = await open(page);
  await attach(page, [
    fixture('first.pdf', [['Application fee: INR 500']]),
    fixture('second.pdf', [['Application fee: INR 500', 'Other text']]),
  ], 2);
  const results = await ask(page, 'Application fee?');
  for (const name of ['Document 1: first.pdf', 'Document 2: second.pdf']) {
    await results.getByRole('region', { name: 'Collection result: ' + name })
      .getByRole('button', { name: 'Inspect collection source [1]' }).click();
    const inspection = root.getByRole('region', { name: 'Collection source inspection' });
    await inspection.getByRole('button', { name: 'Save collection evidence', exact: true }).click();
    await expect(inspection.getByRole('button', { name: 'Saved in collection review' })).toBeDisabled();
    await inspection.getByRole('button', { name: 'Close collection source' }).click();
  }
  await root.getByText('Review saved collection evidence', { exact: true }).click();
  const notebook = root.getByRole('group', { name: 'Collection evidence review notebook' });
  const first = notebook.getByRole('region', { name: /Saved collection evidence: Document 1/ });
  const second = notebook.getByRole('region', { name: /Saved collection evidence: Document 2/ });
  await first.getByLabel('Collection review note').fill('Check payment terms');
  await first.getByLabel('Collection review status').selectOption('needs_followup');
  await second.getByLabel('Collection review note').fill('Other source note');
  await notebook.getByLabel('Review collection status').selectOption('needs_followup');
  await expect(first).toBeVisible();
  await expect(second).toHaveCount(0);
  await notebook.getByLabel('Review collection status').selectOption('all');
  await root.getByRole('button', { name: 'Clear collection questions' }).click();
  await expect(first.getByLabel('Collection review note')).toHaveValue('Check payment terms');
  await expect(second.getByLabel('Collection review note')).toHaveValue('Other source note');
  await root.getByRole('button', { name: 'Remove document 1' }).click();
  await root.getByRole('button', { name: 'Confirm document removal' }).click();
  await root.getByText('Review saved collection evidence', { exact: true }).click();
  await expect(notebook.getByLabel('Collection review note')).toHaveValue('Other source note');
  await expect(notebook.getByLabel('Collection review counts')).toContainText('1 / 100');
});
test('collection private review export and restore require approval and exact source binding', async ({ page }) => {
  const root = await open(page);
  await attach(page, [fixture('private.pdf', [['Application fee: INR 500']])], 1);
  const results = await ask(page, 'Application fee?');
  await results.getByRole('button', { name: 'Inspect collection source [1]' }).click();
  await root.getByRole('button', { name: 'Save collection evidence', exact: true }).click();
  await root.getByRole('button', { name: 'Close collection source' }).click();
  await root.getByText('Review saved collection evidence', { exact: true }).click();
  const notebook = root.getByRole('group', { name: 'Collection evidence review notebook' });
  await notebook.getByLabel('Collection review note').fill('Private note');
  const exportButton = notebook.getByRole('button', { name: 'Export collection review' });
  await expect(exportButton).toBeDisabled();
  await notebook.getByLabel('I approve exporting private collection review annotations.').check();
  const downloadEvent = page.waitForEvent('download');
  await exportButton.click();
  const bytes = await readFile((await (await downloadEvent).path())!);
  expect(bytes.toString()).toContain('Private note');
  expect(bytes.toString()).not.toContain('Application fee: INR 500');
  expect(bytes.toString()).not.toContain('private.pdf');
  await expect(exportButton).toBeDisabled();
  await notebook.getByRole('button', { name: 'Clear collection review notes' }).click();
  await notebook.getByRole('button', { name: 'Confirm clear collection review' }).click();
  await notebook.getByLabel('Import collection review').setInputFiles({ name: 'review.json', mimeType: 'application/json', buffer: bytes });
  await expect(notebook.getByRole('region', { name: 'Collection review restore confirmation' })).toBeVisible();
  await expect(notebook.getByLabel('Collection review note')).toHaveCount(0);
  await notebook.getByRole('button', { name: 'Apply saved collection review' }).click();
  await expect(notebook.getByLabel('Collection review note')).toHaveValue('Private note');
});

test('collection can inspect a blank physical page without creating native evidence or a question', async ({ page }) => {
  const root = await open(page);
  await attach(page, [fixture('blank-page.pdf', [['Application fee: INR 500'], []])], 1);
  await root.getByText('Inspect collection PDF page coverage', { exact: true }).click();
  const coverage = root.getByRole('group', { name: 'Collection page coverage', exact: true });
  await coverage.getByRole('button', { name: 'Inspect collection physical page 2: No indexed text' }).click();
  const inspection = root.getByRole('region', { name: 'Collection source inspection' });
  await expect(inspection.getByRole('heading', { name: /blank-page.pdf.*physical page 2/ })).toBeVisible();
  await expect(inspection.locator('blockquote')).toHaveCount(0);
  await expect(inspection.getByRole('button', { name: 'Save collection evidence', exact: true })).toHaveCount(0);
  await expect(inspection.locator('canvas')).toBeVisible();
  await inspection.getByRole('button', { name: 'Close collection source' }).click();
  await coverage.getByLabel('Collection physical page to inspect').fill('3');
  await coverage.getByRole('button', { name: 'Inspect selected collection page' }).click();
  await expect(coverage.getByRole('alert')).toBeVisible();
  await coverage.getByLabel('Collection physical page to inspect').fill('1');
  await coverage.getByRole('button', { name: 'Inspect selected collection page' }).click();
  await expect(inspection.getByRole('heading', { name: /blank-page.pdf.*physical page 1/ })).toBeVisible();
  await expect(root.getByLabel('Collection conversation')).toHaveCount(0);
});

test('complete collection workspace stages and restores questions and annotations together', async ({ page }) => {
  const root = await open(page);
  await attach(page, [fixture('private.pdf', [['Application fee: INR 500']])], 1);
  const answer = await ask(page, 'Application fee?');
  await answer.getByRole('button', { name: 'Inspect collection source [1]' }).click();
  await root.getByRole('button', { name: 'Save collection evidence', exact: true }).click();
  await root.getByRole('button', { name: 'Close collection source' }).click();
  await root.getByText('Review saved collection evidence', { exact: true }).click();
  const notebook = root.getByRole('group', { name: 'Collection evidence review notebook' });
  await notebook.getByLabel('Collection review note').fill('Private follow-up');
  await root.getByText('Save or restore complete collection workspace', { exact: true }).click();
  const workspace = root.getByRole('group', { name: 'Complete private collection workspace', exact: true });
  const button = workspace.getByRole('button', { name: 'Export complete collection workspace' });
  await expect(button).toBeDisabled();
  await workspace.getByLabel('I approve exporting private collection questions and review notes together.').check();
  const event = page.waitForEvent('download');
  await button.click();
  const bytes = await readFile((await (await event).path())!);
  expect(bytes.toString()).toContain('Private follow-up');
  expect(bytes.toString()).not.toContain('INR 500');
  await root.getByRole('button', { name: 'Clear collection questions' }).click();
  await notebook.getByRole('button', { name: 'Clear collection review notes' }).click();
  await notebook.getByRole('button', { name: 'Confirm clear collection review' }).click();
  await workspace.getByLabel('Import complete collection workspace').setInputFiles({
    name: 'workspace.json', mimeType: 'application/json', buffer: bytes,
  });
  await expect(workspace.getByRole('region', { name: 'Complete collection workspace restore confirmation' })).toBeVisible();
  await expect(root.getByLabel('Collection conversation')).toHaveCount(0);
  await expect(notebook.getByLabel('Collection review note')).toHaveCount(0);
  await workspace.getByRole('button', { name: 'Apply complete collection workspace' }).click();
  await expect(root.getByLabel('Collection results').locator('blockquote')).toHaveText('Application fee: INR 500');
  await expect(notebook.getByLabel('Collection review note')).toHaveValue('Private follow-up');
});

test('collection follow-up uses an explicit earlier question part and previews a new standalone question', async ({ page }) => {
  const root = await open(page);
  await attach(page, [fixture('two.pdf', [['Application fee: INR 500'], ['Application fee: INR 250', 'Eligibility: Class 12']])], 1);
  await ask(page, 'Application fee? Eligibility?');
  const actions = root.getByRole('region', { name: 'Collection history actions' });
  await actions.getByRole('button', { name: 'Prepare collection follow-up' }).click();
  await actions.getByLabel('Earlier collection question part').selectOption('1');
  await actions.getByLabel('Collection follow-up wording').fill('On page 2?');
  await actions.getByRole('button', { name: 'Preview collection follow-up' }).click();
  await expect(actions.getByLabel('Resolved collection follow-up')).toContainText('Eligibility on page 2?');
  await expect(root.getByLabel('View collection question').locator('option')).toHaveCount(1);
  await actions.getByRole('button', { name: 'Use this collection follow-up' }).click();
  await expect(root.getByLabel('Collection question', { exact: true })).toHaveValue('Eligibility on page 2?');
  await root.getByRole('button', { name: 'Ask collection', exact: true }).click();
  await expect(root.getByLabel('Collection results').locator('blockquote')).toHaveText('Eligibility: Class 12');
  await expect(root.getByLabel('View collection question').locator('option')).toHaveCount(2);
});
test('collection history revision requires explicit approval to discard later questions', async ({ page }) => {
  const root = await open(page);
  await attach(page, [fixture('fees.pdf', [['Application fee: INR 500'], ['Application fee: INR 250']])], 1);
  await ask(page, 'Application fee on page 1?');
  await ask(page, 'Application fee on page 2?');
  await root.getByLabel('View collection question').selectOption('0');
  const actions = root.getByRole('region', { name: 'Collection history actions' });
  await actions.getByRole('button', { name: 'Edit collection question' }).click();
  await actions.getByRole('textbox', { name: 'Revised collection question', exact: true }).fill('Application fee on page 2?');
  const apply = actions.getByRole('button', { name: 'Apply revised collection question' });
  await expect(apply).toBeDisabled();
  await actions.getByLabel('I approve discarding 1 later collection question turn(s).').check();
  await apply.click();
  await expect(root.getByLabel('View collection question').locator('option')).toHaveCount(1);
  await expect(root.getByLabel('Collection results').locator('blockquote')).toHaveText('Application fee: INR 250');
  await actions.getByRole('button', { name: 'Remove collection question', exact: true }).click();
  await actions.getByRole('button', { name: 'Keep collection question' }).click();
  await expect(root.getByLabel('View collection question').locator('option')).toHaveCount(1);
  await actions.getByRole('button', { name: 'Remove collection question', exact: true }).click();
  await actions.getByRole('button', { name: 'Confirm collection question removal' }).click();
  await expect(root.getByLabel('Collection conversation')).toHaveCount(0);
});

test('collection sibling panels remain unique through question and selection changes', async ({ page }) => {
  const root = await open(page);
  const warnings: string[] = [];
  page.on('console', message => {
    if (/same key|duplicate key/i.test(message.text())) warnings.push(message.text());
  });
  await attach(page, [
    fixture('first.pdf', [['Application fee: INR 500']]),
    fixture('second.pdf', [['Application fee: INR 350']]),
  ], 2);
  const panels = ['Collection page coverage', 'Collection evidence review notebook', 'Complete private collection workspace'];
  for (let i = 0; i < 3; i++) {
    await ask(page, 'Application fee?');
    await root.getByLabel('Search document 2', { exact: true }).setChecked(i % 2 === 0);
    for (const name of panels) await expect(root.getByRole('group', { name, exact: true })).toHaveCount(1);
    await expect(root.getByRole('textbox', { name: 'Collection question', exact: true })).toHaveCount(1);
    await expect(root.getByText('Save or verify private collection work', { exact: true })).toHaveCount(1);
  }
  expect(warnings).toEqual([]);
});

test('collection date inventory retains independent sources and unsigned calendar spans', async ({ page }) => {
  const root = await open(page);
  await attach(page, [fixture('first.pdf', [['Application deadline: 20 December 2026']]),
    fixture('second.pdf', [['Application deadline: 19 December 2026']])], 2);
  await root.getByText('Inspect printed dates across collection PDFs', { exact: true }).click();
  const dates = root.getByRole('group', { name: 'Collection printed dates', exact: true });
  await expect(dates.getByRole('region', { name: /Collection date:/ })).toHaveCount(2);
  await dates.getByRole('button', { name: 'Compare collection date labels' }).click();
  await expect(dates.getByText('Printed calendar-day span: 1 day(s).')).toBeVisible();
  await dates.getByRole('button', { name: 'Collection date occurrences' }).click();
  await dates.getByRole('region', { name: /Collection date: Document 2/ }).getByRole('button', { name: 'Inspect collection date source' }).click();
  await expect(root.getByRole('region', { name: 'Collection source inspection' }).locator('blockquote')).toHaveText('Application deadline: 19 December 2026');
});

test('collection source fragment browser keeps native inspection within the selected document and page', async ({ page }) => {
  const root = await open(page);
  await attach(page,[fixture('first.pdf',[['Application fee: INR 500','Payment instructions'],['Other page']]),
    fixture('second.pdf',[['Application fee: INR 350','Different instructions']])],2);
  const result = await ask(page,'Application fee?');
  await result.getByRole('region',{name:/Collection result: Document 1/}).getByRole('button',{name:'Inspect collection source [1]'}).click();
  const inspection = root.getByRole('region',{name:'Collection source inspection'});
  await inspection.getByText('Browse native fragments on this collection page',{exact:true}).click();
  const browser = inspection.getByRole('group',{name:'Collection page native fragments'});
  await expect(browser).toContainText('Payment instructions');
  await expect(browser).not.toContainText('Different instructions');
  await expect(browser).not.toContainText('Other page');
  await browser.getByLabel('Find text on this collection page').fill('Payment');
  await expect(browser.getByRole('button',{name:/Inspect collection fragment/})).toHaveCount(1);
  await browser.getByRole('button',{name:/Inspect collection fragment/}).click();
  await expect(inspection.locator('blockquote')).toHaveText('Payment instructions');
  await expect(root.getByLabel('View collection question').locator('option')).toHaveCount(1);
});

test('collection export approvals are invalidated by a change to question history', async ({ page }) => {
  const root = await open(page);
  await attach(page, [fixture('notice.pdf', [['Application fee: INR 500', 'Eligibility: Class 12']])], 1);
  await ask(page, 'Application fee?');
  await root.getByText('Save or verify private collection work', { exact: true }).click();
  const plan = root.getByRole('button', { name: 'Export collection question plan' });
  const report = root.getByRole('button', { name: 'Export collection evidence report' });
  await root.getByLabel('I approve exporting private collection questions and fingerprints.').check();
  await root.getByLabel('I approve exporting private collection excerpts and questions.').check();
  await expect(plan).toBeEnabled();
  await expect(report).toBeEnabled();
  await ask(page, 'Eligibility?');
  await expect(plan).toBeDisabled();
  await expect(report).toBeDisabled();
  await expect(root.getByLabel('I approve exporting private collection questions and fingerprints.')).not.toBeChecked();
  await expect(root.getByLabel('I approve exporting private collection excerpts and questions.')).not.toBeChecked();
});

test('collection batch stages independent questions and appends only on confirmation', async ({page})=>{
  const root=await open(page);
  await attach(page,[fixture('a.pdf',[['Application fee: INR 500','Eligibility: Class 12']]),fixture('b.pdf',[['Application fee: INR 350']])],2);
  await root.getByText('Prepare a collection question batch',{exact:true}).click();
  const panel=root.getByRole('group',{name:'Collection batch question workbench',exact:true});
  await panel.getByLabel('Collection batch questions').fill('Application fee?\nEligibility?');
  await panel.getByRole('button',{name:'Run collection question batch'}).click();
  const staged=panel.getByRole('region',{name:'Prepared collection batch'});
  await expect(staged).toBeVisible();
  await expect(root.getByLabel('Collection conversation')).toHaveCount(0);
  await staged.getByRole('button',{name:'Append prepared collection questions'}).click();
  await expect(root.getByLabel('View collection question').locator('option')).toHaveCount(2);
  await expect(root.getByLabel('Collection results').locator('blockquote')).toHaveText('Eligibility: Class 12');
  await expect(staged).toHaveCount(0);
});

test('collection diagnostics do not replace insufficient answers or automatically broaden document scope',async({page})=>{
  const root=await open(page);
  await attach(page,[fixture('a.pdf',[['Registration certificate required']]),fixture('b.pdf',[['Registration certifacate required']])],2);
  const results=await ask(page,'Registration certifacate?');
  const first=results.getByRole('region',{name:/Collection result: Document 1/});
  await first.getByText('Diagnose collection search coverage',{exact:true}).click();
  await expect(first).toContainText('One or more normalized search terms');
  await first.getByRole('button',{name:'Draft collection alternative: certificate',exact:true}).click();
  await expect(root.getByLabel('Collection question',{exact:true})).toHaveValue('Registration certificate?');
  await expect(root.getByLabel('Search document 1',{exact:true})).toBeChecked();
  await expect(root.getByLabel('Search document 2',{exact:true})).not.toBeChecked();
  await expect(first).toContainText('No matching indexed evidence');
  await expect(root.getByLabel('View collection question').locator('option')).toHaveCount(1);
});

test('collection requirement cues keep exact counterparts separate from inferred changes',async({page})=>{
  const root=await open(page);
  await attach(page,[fixture('a.pdf',[['Applicants must submit a certificate','Do not pay cash']]),fixture('b.pdf',[['Applicants must submit a certificate']])],2);
  await root.getByText('Inspect requirement wording across collection PDFs',{exact:true}).click();
  const panel=root.getByRole('group',{name:'Collection requirement inspection',exact:true});
  await panel.getByLabel('Collection requirement wording').selectOption('shared');
  await expect(panel.getByRole('status')).toContainText('2 collection requirement fragment(s)');
  await panel.getByLabel('Collection requirement wording').selectOption('unshared');
  await expect(panel.getByRole('status')).toContainText('1 collection requirement fragment(s)');
  await panel.getByRole('button',{name:'Inspect collection requirement source',exact:true}).click();
  await expect(root.getByRole('region',{name:'Collection source inspection'}).locator('blockquote')).toHaveText('Do not pay cash');
});

test('collection outline requires explicit physical section candidates before alignment',async({page})=>{
  const root=await open(page);
  await attach(page,[fixture('a.pdf',[['Eligibility criteria','Class 12','Age 18']]),fixture('b.pdf',[['Eligibility criteria','Class 12','Age 21']])],2);
  await root.getByText('Explore collection document structure',{exact:true}).click();
  const panel=root.getByRole('group',{name:'Collection candidate outline',exact:true});
  await expect(panel.getByRole('status')).toContainText('2 matching collection heading candidate(s)');
  await panel.getByRole('button',{name:'Browse collection section',exact:true}).first().click();
  const align=panel.getByRole('button',{name:'Align selected collection sections'});
  await expect(align).toBeDisabled();
  await panel.getByLabel('Choose second collection section').selectOption({index:1});
  await align.click();
  const result=panel.getByRole('region',{name:'Collection section exact alignment'});
  await expect(result).toContainText('2 matching fragments');
  await result.getByLabel('Only unpaired collection fragments').check();
  await expect(result).toContainText('Age 18');
  await expect(result).toContainText('Age 21');
});

test('collection snapshot export and independent replay bind to exact real PDF bytes',async({page})=>{
  const root=await open(page);
  const original=fixture('original.pdf',[['Application fee: INR 500']]);
  await attach(page,[original],1);
  await root.getByText('Export native collection snapshot or independently replay sources',{exact:true}).click();
  const panel=root.getByRole('group',{name:'Independent collection source replay',exact:true});
  const exportButton=panel.getByRole('button',{name:'Export native collection snapshot'});
  await expect(exportButton).toBeDisabled();
  await panel.getByLabel('I approve exporting the private native collection text.').check();
  const event=page.waitForEvent('download');await exportButton.click();
  const bytes=await readFile((await (await event).path())!);
  await panel.getByLabel('Collection replay snapshot file').setInputFiles({name:'snapshot.json',mimeType:'application/json',buffer:bytes});
  await panel.getByLabel('Collection replay source PDFs').setInputFiles({...original,name:'renamed.pdf'});
  await panel.getByRole('button',{name:'Run independent collection source replay'}).click();
  const result=panel.getByRole('region',{name:'Collection source replay results'});
  await expect(result).toContainText('All native extractions exactly reproduced');
  await panel.getByRole('button',{name:'Clear replay PDFs'}).click();
  await panel.getByRole('button',{name:'Run independent collection source replay'}).click();
  await expect(result).toContainText('Expected PDF not selected');
});

test('collection AI preparation is local and requires explicit consent for exporting scoped requests',async({page})=>{
  const api:string[]=[];
  await page.route('**/api/**',route=>{api.push(route.request().url());return route.abort();});
  const root=await open(page);
  await attach(page,[fixture('a.pdf',[['Application fee: INR 500']]),fixture('b.pdf',[['Application fee: INR 350']])],2);
  await ask(page,'Application fee?');
  await root.getByText('Optional independent collection AI proposals',{exact:true}).click();
  const panel=root.getByRole('group',{name:'Collection local model experiments',exact:true});
  await panel.getByRole('button',{name:'Prepare independent collection model plan'}).click();
  await expect(panel.getByText(/2 independent request/)).toBeVisible();
  const first=panel.getByRole('region',{name:/Collection model request: Document 1/});
  const button=first.getByRole('button',{name:'Export this collection model request'});
  await expect(button).toBeDisabled();
  await panel.getByLabel('I approve exporting this collection model plan and private request text.').check();
  const event=page.waitForEvent('download');await button.click();
  const bytes=await readFile((await (await event).path())!);
  expect(bytes.toString()).toContain('INR 500');expect(bytes.toString()).not.toContain('INR 350');
  expect(api).toEqual([]);
});

test('collection evaluation uses explicit human source labels and reports retrieval agreement',async({page})=>{
  const root=await open(page);
  await attach(page,[fixture('a.pdf',[['Application fee: INR 500','Eligibility: Class 12']])],1);
  await ask(page,'Application fee?');
  await root.getByText('Evaluate collection retrieval against human labels',{exact:true}).click();
  const panel=root.getByRole('group',{name:'Collection retrieval evaluation lab',exact:true});
  await panel.getByRole('button',{name:'Prepare human retrieval label'}).click();
  await panel.getByLabel('Expected physical page').fill('1');
  await panel.getByLabel('Expected fragment ordinal').fill('1');
  await panel.getByRole('button',{name:'Add expected retrieval fragment'}).click();
  await panel.getByRole('button',{name:'Save human retrieval label'}).click();
  await panel.getByRole('button',{name:'Run labelled collection retrieval evaluation'}).click();
  const result=panel.getByRole('region',{name:'Collection retrieval evaluation results'});
  await expect(result).toContainText('All labelled fragments retrieved');
  await expect(result).toContainText('100.0%');
  const exportButton=panel.getByRole('button',{name:'Export collection retrieval labels'});
  await expect(exportButton).toBeDisabled();
  await panel.getByLabel('I approve exporting private collection retrieval evaluation data.').check();
  const event=page.waitForEvent('download');await exportButton.click();
  const bytes=await readFile((await (await event).path())!);
  expect(bytes.toString()).not.toContain('INR 500');
  await expect(exportButton).toBeDisabled();
});

test('collection OCR review binds exact PDF bytes and does not enter native citations',async({page})=>{
  const root=await open(page);
  const input=fixture('notice.pdf',[['Application fee: INR 500']]);
  await attach(page,[input],1);
  const {createHash}=await import('node:crypto');
  const id=createHash('sha256').update(input.buffer).digest('hex');
  await ask(page,'Eligibility?');
  await root.getByText('Review scanned collection PDFs with optional local OCR',{exact:true}).click();
  const panel=root.getByRole('group',{name:'Collection scanned PDF review',exact:true});
  const report=JSON.stringify({format:'noticebridge-chat-ocr-review',version:1,source_sha256:id,role:'original',
    page_count:1,pages:[{page:1,status:'ok',lines:[{ordinal:1,text:'Eligibility: Class 12'}]}]},null,2)+'\n';
  await panel.getByLabel('Import collection OCR review for selected PDF').setInputFiles({name:'ocr.json',mimeType:'application/json',buffer:Buffer.from(report)});
  await panel.getByRole('button',{name:'Apply unverified collection OCR review'}).click();
  await panel.getByText('Search OCR review for the selected collection question',{exact:true}).click();
  await expect(panel.getByRole('region',{name:/Collection OCR matches:/})).toContainText('Eligibility: Class 12');
  await expect(root.getByLabel('Collection results').locator('blockquote')).toHaveCount(0);
  await panel.getByRole('button',{name:'Inspect collection OCR match page 1'}).click();
  await expect(root.getByRole('region',{name:'Collection source inspection'}).locator('blockquote')).toHaveCount(0);
});

test('collection review packet is independently verified without replacing current questions',async({page})=>{
  const root=await open(page);
  await attach(page,[fixture('a.pdf',[['Application fee: INR 500']])],1);
  await ask(page,'Application fee?');
  await root.getByText('Export or verify collection evidence review packet',{exact:true}).click();
  const panel=root.getByRole('group',{name:'Private collection review packet',exact:true});
  const button=panel.getByRole('button',{name:'Export canonical collection review packet'});
  await expect(button).toBeDisabled();
  await panel.getByLabel('I approve exporting these private collection excerpts, questions and review notes.').check();
  const event=page.waitForEvent('download');await button.click();
  const bytes=await readFile((await (await event).path())!);
  await expect(button).toBeDisabled();
  await root.getByRole('button',{name:'Clear collection questions'}).click();
  await panel.getByLabel('Verify collection review packet').setInputFiles({name:'packet.json',mimeType:'application/json',buffer:bytes});
  await expect(panel.getByRole('region',{name:'Verified collection packet details'})).toContainText('Exact collection packet replay matched');
  await expect(root.getByLabel('Collection conversation')).toHaveCount(0);
});

test('collection tool directory opens the actual destination and preserves question state',async({page})=>{
  const root=await open(page);
  const directory=root.getByRole('group',{name:'Collection workspace navigation',exact:true});
  await directory.getByText('Find a collection workspace tool',{exact:true}).click();
  await directory.getByLabel('Find collection tool').fill('OCR');
  await expect(directory.getByRole('button',{name:'Open Scanned PDF review'})).toBeDisabled();
  await attach(page,[fixture('a.pdf',[['Application fee: INR 500']])],1);
  await root.getByLabel('Collection question',{exact:true}).fill('Application fee?');
  await directory.getByRole('button',{name:'Open Scanned PDF review'}).click();
  const ocr=root.getByRole('group',{name:'Collection scanned PDF review',exact:true});
  await expect(ocr.getByLabel('Collection OCR source PDF')).toBeVisible();
  await expect(root.getByLabel('Collection question',{exact:true})).toHaveValue('Application fee?');
  await expect(ocr.locator('summary')).toBeFocused();
  await directory.getByLabel('Find collection tool').fill('regression');
  await directory.getByRole('button',{name:'Open Retrieval evaluation'}).click();
  await expect(root.getByRole('group',{name:'Collection retrieval evaluation lab',exact:true})).toHaveAttribute('open','');
});

test('collection question overview keeps literal values separate and links each source',async({page})=>{
  const root=await open(page);
  await attach(page,[fixture('a.pdf',[['Application fee: INR 500']]),fixture('b.pdf',[['Application fee: INR 350']])],2);
  await ask(page,'Application fee?');
  await root.getByText('At a glance: collection question evidence',{exact:true}).click();
  const overview=root.getByRole('group',{name:'Collection question at a glance',exact:true});
  await expect(overview).toContainText('PDFs have different literal printed values');
  await overview.getByRole('button',{name:'Inspect printed value page 1:1',exact:true}).last().click();
  await expect(root.getByRole('region',{name:'Collection source inspection'}).locator('blockquote')).toHaveText('Application fee: INR 350');
  await expect(root.getByLabel('Collection results').locator('blockquote')).toHaveCount(2);
});

test('collection source location is opt-in and freshly reproduced on the rendered PDF',async({page})=>{
  const root=await open(page);
  await attach(page,[fixture('notice.pdf',[['Application fee: INR 500']])],1);
  const results=await ask(page,'Application fee?');
  await results.getByRole('button',{name:'Inspect collection source [1]'}).click();
  const inspection=root.getByRole('region',{name:'Collection source inspection'});
  await expect(inspection.locator('canvas')).toBeVisible();
  await expect(inspection.locator('.native-location-marker')).toHaveCount(0);
  await inspection.getByLabel('Show independently reproduced candidate line location').check();
  await expect(inspection).toContainText('Candidate native line location reproduced');
  await expect(inspection.locator('.native-location-marker')).toBeVisible();
  await inspection.getByLabel('Show independently reproduced candidate line location').uncheck();
  await expect(inspection.locator('.native-location-marker')).toHaveCount(0);
});

test('review queue opens exact saved turns and protects an unsent question draft',async({page})=>{
  const root=await open(page);
  await attach(page,[fixture('a.pdf',[['Application fee: INR 500']]),fixture('b.pdf',[['Application fee: INR 350']])],2);
  await ask(page,'Application fee?');await ask(page,'Eligibility?');
  const queue=root.getByRole('group',{name:'Collection question review queue',exact:true});
  await queue.locator('summary').click();
  await queue.getByRole('button',{name:'Build collection review queue'}).click();
  await expect(queue).toContainText('Review queue recomputed.');
  await queue.getByLabel('Review queue reason').selectOption('different_values');
  const first=queue.getByRole('article',{name:/Review queue turn 1 part 1 Document 1/});
  await expect(first).toContainText('Different literal values');
  await first.getByRole('button',{name:'Open saved question turn 1'}).click();
  await expect(root.getByLabel('View collection question')).toHaveValue('0');
  const input=root.getByLabel('Collection question',{exact:true});
  await input.fill('Unsent draft');
  await expect(first.getByRole('button',{name:'Draft question for this PDF'})).toBeDisabled();
  await input.clear();
  await first.getByRole('button',{name:'Draft question for this PDF'}).click();
  await expect(input).toHaveValue('Application fee?');
  await expect(root.getByLabel('Search document 2',{exact:true})).not.toBeChecked();
  await first.getByText('Inspect queue source candidates',{exact:true}).click();
  await first.getByRole('button',{name:'Inspect review candidate 1:1',exact:true}).click();
  const inspection=root.getByRole('region',{name:'Collection source inspection'});
  await expect(inspection.locator('blockquote')).toHaveText('Application fee: INR 500');
  await inspection.getByRole('button',{name:'Save collection evidence',exact:true}).click();
  await expect(queue).toContainText('Collection work changed. Rebuild the queue');
  await expect(queue.getByRole('button',{name:'Export collection review queue'})).toHaveCount(0);
  await queue.getByRole('button',{name:'Build collection review queue'}).click();
  await expect(queue).toContainText('Review queue recomputed.');
  const exportButton=queue.getByRole('button',{name:'Export collection review queue'});
  await expect(exportButton).toBeDisabled();
  await queue.getByLabel('I approve exporting private question text, fingerprints and diagnostic coordinates.').check();
  const download=page.waitForEvent('download');await exportButton.click();
  const bytes=await readFile((await (await download).path())!);
  expect(bytes.toString()).not.toContain('INR 500');
  await expect(exportButton).toBeDisabled();
  await queue.getByLabel('Verify saved collection review queue').setInputFiles({name:'queue.json',mimeType:'application/json',buffer:bytes});
  await expect(queue).toContainText('Exact review queue replay matched.');
});
test('literal overlap preserves source identity and independently verifies coordinate export',async({page})=>{
  const root=await open(page);
  await attach(page,[fixture('a.pdf',[['Common notice heading','Application fee: INR 500']]),
    fixture('b.pdf',[['Common notice heading','Application fee: INR 350']])],2);
  const panel=root.getByRole('group',{name:'Literal collection text overlap',exact:true});
  await panel.locator('summary').click();
  await panel.getByRole('button',{name:'Compute selected PDF literal overlap'}).click();
  await expect(panel).toContainText('1 distinct native text(s) match.');
  await panel.getByText('Inspect physical occurrences',{exact:true}).click();
  await panel.getByRole('button',{name:'Inspect occurrence 1:1',exact:true}).last().click();
  const preview=root.getByRole('region',{name:'Collection source inspection'});
  await expect(preview).toContainText('Document 2: b.pdf');
  await expect(preview.locator('blockquote')).toHaveText('Common notice heading');
  await panel.getByLabel('Overlap presence').selectOption('exclusive');
  await expect(panel).toContainText('2 distinct native text(s) match.');
  const button=panel.getByRole('button',{name:'Export collection literal overlap'});
  await expect(button).toBeDisabled();
  await panel.getByLabel('I approve exporting private PDF fingerprints and native occurrence coordinates.').check();
  const download=page.waitForEvent('download');await button.click();
  const bytes=await readFile((await (await download).path())!);
  expect(bytes.toString()).not.toContain('Common notice heading');
  await expect(button).toBeDisabled();
  await panel.getByLabel('Verify saved collection literal overlap').setInputFiles({name:'overlap.json',mimeType:'application/json',buffer:bytes});
  await expect(panel).toContainText('Exact literal overlap report replay matched.');
  await root.getByLabel('Search document 2',{exact:true}).uncheck();
  await panel.locator('summary').click();
  await expect(panel.getByRole('button',{name:'Compute selected PDF literal overlap'})).toBeDisabled();
  await expect(panel.getByRole('button',{name:'Export collection literal overlap'})).toHaveCount(0);
});

test('boolean evidence search uses exact fragment-local operators and does not create a chat turn',async({page})=>{
  const root=await open(page);
  await attach(page,[fixture('a.pdf',[['Application fee: INR 500 for rural applicants','Application fee: INR 350 refundable']]),
    fixture('b.pdf',[['Application fee: INR 350','Rural applicants']])],2);
  const panel=root.getByRole('group',{name:'Boolean literal evidence search',exact:true});
  await panel.locator('summary').first().click();
  const input=panel.getByLabel('Boolean evidence expression');
  await input.fill('"application fee" AND "rural" AND NOT "refundable"');
  await panel.getByRole('button',{name:'Search boolean collection evidence'}).click();
  await expect(panel).toContainText('1 matching native fragment(s) across 2 selected PDF(s).');
  await expect(panel.locator('mark')).toHaveText(['Application fee','rural']);
  await panel.getByRole('button',{name:'Inspect boolean match 1:1'}).click();
  await expect(root.getByRole('region',{name:'Collection source inspection'}).locator('blockquote')).toHaveText('Application fee: INR 500 for rural applicants');
  await expect(root.getByLabel('Collection conversation')).toHaveCount(0);
  await input.fill('NOT "refundable"');
  await panel.getByRole('button',{name:'Search boolean collection evidence'}).click();
  await expect(panel.getByRole('alert')).toContainText('Each alternative must require a positive phrase');
  await expect(panel.getByLabel('Boolean collection evidence results')).toHaveCount(0);
});

test('printed reference index and source trail keep other-PDF candidates opt-in',async({page})=>{
  const root=await open(page);
  await attach(page,[fixture('a.pdf',[['Clause 4.2(a) Eligibility','Applicants must consult Clause 4.2(a).']]),
    fixture('b.pdf',[['Clause 4.2(a) Other notice']])],2);
  const index=root.getByRole('group',{name:'Collection reference index',exact:true});
  await index.locator('summary').first().click();
  await index.getByLabel('Reference kind').selectOption('clause');
  await expect(index).toContainText('1 of 1 reference identifier(s) match.');
  await expect(index).toContainText('Repeated leading identifier candidates');
  await index.getByText('Document 1: a.pdf: 1 leading, 1 inline',{exact:true}).click();
  await index.getByRole('button',{name:'Inspect reference occurrence 1:2',exact:true}).click();
  const preview=root.getByRole('region',{name:'Collection source inspection'});
  await expect(preview.locator('blockquote')).toHaveText('Applicants must consult Clause 4.2(a).');
  const trail=preview.getByRole('group',{name:'Follow printed source references',exact:true});
  await trail.locator('summary').first().click();
  await expect(trail).toContainText('1 other occurrence(s) in the same PDF.');
  await expect(trail.getByText(/Independent other-PDF mentions/)).toHaveCount(0);
  await trail.getByLabel('Also search other attached PDFs independently').check();
  await trail.getByText('Independent other-PDF mentions (1)',{exact:true}).click();
  await trail.getByRole('button',{name:'Inspect reference occurrence 1:1',exact:true}).last().click();
  await expect(preview.locator('blockquote')).toHaveText('Clause 4.2(a) Other notice');
  await expect(root.getByLabel('Collection conversation')).toHaveCount(0);
});

test('independent scoped question planner previews mixed selections and preserves order on apply',async({page})=>{
  const root=await open(page);
  await attach(page,[fixture('a.pdf',[['Application fee: INR 500']]),fixture('b.pdf',[['Eligibility: Class 12']])],2);
  const plan=root.getByRole('group',{name:'Independently scoped question planner',exact:true});
  await plan.locator('summary').first().click();
  await plan.getByRole('button',{name:'Add scoped question'}).click();
  await plan.getByRole('button',{name:'Add scoped question'}).click();
  await plan.getByLabel('Question 1',{exact:true}).fill('Application fee?');
  await plan.getByLabel('Question 2',{exact:true}).fill('Eligibility?');
  await plan.getByLabel('Search Document 2: b.pdf for question 1',{exact:true}).uncheck();
  await plan.getByLabel('Search Document 1: a.pdf for question 2',{exact:true}).uncheck();
  await plan.getByLabel('Search nearby lines for question 2',{exact:true}).check();
  await plan.getByRole('button',{name:'Move question 2 earlier'}).click();
  await expect(plan.getByLabel('Question 1',{exact:true})).toHaveValue('Eligibility?');
  await plan.getByRole('button',{name:'Prepare independently scoped plan'}).click();
  await expect(plan.getByRole('region',{name:'Prepared independently scoped plan'})).toContainText('2 independent searches');
  await expect(root.getByLabel('Collection conversation')).toHaveCount(0);
  await plan.getByRole('button',{name:'Append independently scoped questions'}).click();
  await expect(root.getByLabel('View collection question')).toHaveValue('1');
  await expect(root.getByLabel('Collection results').locator('blockquote')).toHaveText('Application fee: INR 500');
  await root.getByLabel('View collection question').selectOption('0');
  await expect(root.getByLabel('Collection results').locator('blockquote')).toHaveText('Eligibility: Class 12');
});

test('explicit local checkpoint survives reload and can be deleted without clearing live work',async({page})=>{
  const root=await open(page);
  await attach(page,[fixture('a.pdf',[['Application fee: INR 500']]),fixture('b.pdf',[['Eligibility: Class 12']])],2);
  const results=await ask(page,'Application fee?');
  await results.getByRole('button',{name:'Inspect collection source [1]'}).click();
  await root.getByRole('region',{name:'Collection source inspection'}).getByRole('button',{name:'Save collection evidence',exact:true}).click();
  await root.getByLabel('Search document 1',{exact:true}).uncheck();
  const panel=root.getByRole('group',{name:'Explicit browser-local collection checkpoint',exact:true});
  await panel.locator('summary').first().click();
  await panel.getByRole('button',{name:'Check local collection checkpoint'}).click();
  await expect(panel).toContainText('No local collection checkpoint.');
  await expect(panel.getByRole('button',{name:'Save local collection checkpoint'})).toBeDisabled();
  await panel.getByLabel('I approve storing the actual private PDFs, filenames, native text and saved work on this browser.').check();
  await panel.getByRole('button',{name:'Save local collection checkpoint'}).click();
  await expect(panel).toContainText('Private collection checkpoint saved in this browser profile.');
  await page.reload();
  await page.getByText('Search an independent PDF collection (up to six documents)',{exact:true}).click();
  await expect(root.getByLabel('Collection processing budget')).toContainText('0 / 6');
  await panel.locator('summary').first().click();
  await panel.getByRole('button',{name:'Check local collection checkpoint'}).click();
  await expect(panel).toContainText('2 saved PDF(s)');
  await panel.getByRole('button',{name:'Prepare local checkpoint restore'}).click();
  await expect(panel.getByRole('region',{name:'Local checkpoint restore preview'})).toContainText('Exact native extraction and workspace replay matched');
  await expect(root.getByLabel('Collection processing budget')).toContainText('0 / 6');
  await panel.getByRole('button',{name:'Apply verified local checkpoint'}).click();
  await expect(root.getByLabel('Collection processing budget')).toContainText('2 / 6');
  await expect(root.getByLabel('Search document 1',{exact:true})).not.toBeChecked();
  await expect(root.getByLabel('Search document 2',{exact:true})).toBeChecked();
  await expect(root.getByLabel('Collection results').locator('blockquote')).toHaveText('Application fee: INR 500');
  await panel.getByLabel('Delete stored checkpoint and its private files').check();
  await panel.getByRole('button',{name:'Delete local collection checkpoint'}).click();
  await expect(panel).toContainText('Local collection checkpoint deleted.');
  await expect(root.getByLabel('Collection processing budget')).toContainText('2 / 6');
  await page.reload();
  await page.getByText('Search an independent PDF collection (up to six documents)',{exact:true}).click();
  await panel.locator('summary').first().click();
  await panel.getByRole('button',{name:'Check local collection checkpoint'}).click();
  await expect(panel).toContainText('No local collection checkpoint.');
});

test('checkpoint replacement uses a storage revision lease across two tabs',async({page,context})=>{
  const root=await open(page);
  await attach(page,[fixture('a.pdf',[['Application fee: INR 500']])],1);
  const panel=root.getByRole('group',{name:'Explicit browser-local collection checkpoint',exact:true});
  await panel.locator('summary').first().click();
  await panel.getByRole('button',{name:'Check local collection checkpoint'}).click();
  await expect(panel).toContainText('No local collection checkpoint.');
  const other=await context.newPage();
  const otherRoot=await open(other);
  await attach(other,[fixture('b.pdf',[['Eligibility: Class 12']])],1);
  const otherPanel=otherRoot.getByRole('group',{name:'Explicit browser-local collection checkpoint',exact:true});
  await otherPanel.locator('summary').first().click();
  await otherPanel.getByRole('button',{name:'Check local collection checkpoint'}).click();
  await expect(otherPanel).toContainText('No local collection checkpoint.');
  const consent='I approve storing the actual private PDFs, filenames, native text and saved work on this browser.';
  await panel.getByLabel(consent).check();
  await panel.getByRole('button',{name:'Save local collection checkpoint'}).click();
  await expect(panel).toContainText('Private collection checkpoint saved in this browser profile.');
  await otherPanel.getByLabel(consent).check();
  await otherPanel.getByRole('button',{name:'Save local collection checkpoint'}).click();
  await expect(otherPanel.getByRole('alert')).toContainText('checkpoint changed');
  await otherPanel.getByRole('button',{name:'Check local collection checkpoint'}).click();
  await otherPanel.getByRole('button',{name:'Prepare local checkpoint restore'}).click();
  await expect(otherPanel.getByRole('region',{name:'Local checkpoint restore preview'})).toContainText('Exact native extraction and workspace replay matched');
  await otherPanel.getByRole('button',{name:'Apply verified local checkpoint'}).click();
  await expect(otherRoot.getByText('Document 1: a.pdf',{exact:true}).first()).toBeVisible();
  await other.close();
});
