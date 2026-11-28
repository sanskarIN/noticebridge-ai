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
