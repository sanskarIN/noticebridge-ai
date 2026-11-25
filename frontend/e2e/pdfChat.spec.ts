import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';

function pdf(lines: string[]): Buffer {
  const stream = lines.map((line, i) =>
    'BT /F1 12 Tf 40 ' + (720 - i * 30) + ' Td (' + line + ') Tj ET\n',
  ).join('');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + 'endstream',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(body));
    body += (i + 1) + ' 0 obj\n' + object + '\nendobj\n';
  });
  const xref = Buffer.byteLength(body);
  body += 'xref\n0 6\n0000000000 65535 f \n';
  for (const offset of offsets) body += String(offset).padStart(10, '0') + ' 00000 n \n';
  body += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(body);
}
async function attach(page: Page, role: 'Original / first PDF' | 'Updated / second PDF', lines: string[]) {
  await page.getByLabel(role, { exact: true }).setInputFiles({
    name: 'fictional.pdf', mimeType: 'application/pdf', buffer: pdf(lines),
  });
}
async function ask(page: Page, question: string) {
  await page.getByLabel('Your question').fill(question);
  await page.getByRole('button', { name: 'Ask PDF' }).click();
  return page.locator('.chat-turn').last();
}
test('navigation opens PDF chat', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Chat with PDFs' }).click();
  await expect(page.getByRole('heading', { name: 'Chat with your PDFs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask PDF' })).toBeDisabled();
});
test('fictional notices answer fee and deadline questions locally with real PDF citations', async ({ page }) => {
  const api: string[] = [];
  await page.route('**/api/**', route => { api.push(route.request().url()); return route.abort(); });
  await page.goto('/?view=chat');
  await page.getByRole('button', { name: 'Try fictional notices' }).click();
  await expect(page.getByText(/extracted passages available/)).toHaveCount(2);
  await page.getByLabel('Your question').fill('What is the application fee?');
  await expect(page.getByRole('button', { name: 'Ask PDF' })).toBeEnabled();
  const fee = await ask(page, 'What is the application fee?');
  await expect(fee.locator('blockquote')).toHaveText(['Application fee: Rs. 500', 'Application fee: Rs. 350']);
  await expect(fee.getByRole('heading', { name: 'Printed values in matching passages' })).toBeVisible();
  const deadline = await ask(page, 'What is the application deadline?');
  await expect(deadline.locator('blockquote')).toHaveText([
    'Application deadline: 19 December 2026', 'Application deadline: 13 December 2026',
  ]);
  await deadline.getByRole('button', { name: 'Inspect source [1]', exact: true }).click();
  await expect(page.getByText('Source page shown for manual inspection.')).toBeVisible();
  await expect(page.locator('.pdf-preview-body canvas')).toBeVisible();
  expect(api).toEqual([]);
});
test('a single local PDF includes unchanged facts and does not guess unsupported answers', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', [
    'Application deadline: 13 December 2026', 'Eligibility: Class 12 or equivalent',
  ]);
  await page.getByLabel('Your question').fill('Who can apply?');
  await expect(page.getByRole('button', { name: 'Ask PDF' })).toBeEnabled();
  const eligible = await ask(page, 'Who can apply?');
  await expect(eligible.locator('blockquote')).toHaveText('Eligibility: Class 12 or equivalent');
  const missing = await ask(page, 'What is the application refund policy?');
  await expect(missing.getByRole('heading', { name: 'Insufficient matching evidence' })).toBeVisible();
  await expect(missing.locator('blockquote')).toHaveCount(0);
});
test('follow-up reuses explicit prior question and selected source scope', async ({ page }) => {
  await page.goto('/?view=chat');
  await page.getByRole('button', { name: 'Try fictional notices' }).click();
  await expect(page.getByText(/extracted passages available/)).toHaveCount(2);
  await page.getByLabel('Your question').fill('Application fee');
  await expect(page.getByRole('button', { name: 'Ask PDF' })).toBeEnabled();
  await page.getByLabel('Search scope').selectOption('original');
  await ask(page, 'Application fee');
  await page.getByLabel('Search scope').selectOption('revised');
  await page.getByLabel('Include previous question as search context').check();
  const followup = await ask(page, 'What about the updated notice?');
  await expect(followup.locator('blockquote')).toHaveText('Application fee: Rs. 350');
  await expect(followup.getByText(/Search context:/)).toBeVisible();
});
test('replacing a PDF clears previous answers and source preview', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', ['Application fee: Rs. 500']);
  await page.getByLabel('Your question').fill('Application fee');
  await expect(page.getByRole('button', { name: 'Ask PDF' })).toBeEnabled();
  await ask(page, 'Application fee');
  await page.getByRole('button', { name: 'Inspect source [1]', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Source page inspection' })).toBeVisible();
  await attach(page, 'Original / first PDF', ['Application fee: Rs. 350']);
  await expect(page.locator('.chat-turn')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Source page inspection' })).toHaveCount(0);
  await page.getByLabel('Your question').fill('Application fee');
  await expect(page.getByRole('button', { name: 'Ask PDF' })).toBeEnabled();
  const answer = await ask(page, 'Application fee');
  await expect(answer.locator('blockquote')).toHaveText('Application fee: Rs. 350');
});
test('blank pages warn and abstain', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', []);
  await expect(page.getByText(/No indexed text on pages 1/)).toBeVisible();
  const answer = await ask(page, 'Application deadline');
  await expect(answer.getByRole('heading', { name: 'Insufficient matching evidence' })).toBeVisible();
});
test('oversized input never becomes a searchable document', async ({ page }) => {
  await page.goto('/?view=chat');
  await page.getByLabel('Original / first PDF', { exact: true }).setInputFiles({
    name: 'large.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Your question').fill('Application deadline');
  await expect(page.getByRole('button', { name: 'Ask PDF' })).toBeDisabled();
});
test('narrow view and clear conversation stay usable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', ['Application fee: Rs. 500']);
  await page.getByLabel('Your question').fill('Application fee');
  await expect(page.getByRole('button', { name: 'Ask PDF' })).toBeEnabled();
  await ask(page, 'Application fee');
  await page.getByRole('button', { name: 'Clear conversation' }).click();
  await expect(page.locator('.chat-turn')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321);
});


test('compound question provides separate grounded answers and printed comparisons', async ({ page }) => {
  await page.goto('/?view=chat');
  await page.getByRole('button', { name: 'Try fictional notices' }).click();
  await expect(page.getByText(/extracted passages available/)).toHaveCount(2);
  const result = await ask(page, 'What are the application deadline and fee?');
  const sections = result.locator('.chat-answer');
  await expect(sections).toHaveCount(2);
  await expect(sections.nth(0).locator('blockquote')).toHaveText([
    'Application deadline: 19 December 2026', 'Application deadline: 13 December 2026',
  ]);
  await expect(sections.nth(1).locator('blockquote')).toHaveText([
    'Application fee: Rs. 500', 'Application fee: Rs. 350',
  ]);
  await expect(result.getByText('Different displayed wording')).toHaveCount(2);
  await expect(page.getByLabel('Include previous question as search context')).toBeDisabled();
});
test('compound question preserves a missing answer without hiding a supported one', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', ['Application fee: Rs. 500']);
  await expect(page.getByText(/extracted passages available/)).toBeVisible();
  const result = await ask(page, 'Application fee? Refund policy?');
  await expect(result.locator('.chat-answer')).toHaveCount(2);
  await expect(result.locator('blockquote')).toHaveText('Application fee: Rs. 500');
  await expect(result.getByRole('heading', { name: 'Insufficient matching evidence' })).toBeVisible();
});
test('same-label competing printed values trigger manual review wording', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', [
    'Application fee: Rs. 500', 'Application fee: Rs. 900',
  ]);
  await expect(page.getByText(/extracted passages available/)).toBeVisible();
  const result = await ask(page, 'Application fee');
  await expect(result.locator('blockquote')).toHaveCount(2);
  await expect(result.getByText(/Multiple printed values for Application fee/)).toBeVisible();
});
test('nearby context is kept separate from the answer quotations', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', [
    'Fictional notice only', 'Application fee: Rs. 500', 'Refund policy: No refunds',
  ]);
  await expect(page.getByText(/extracted passages available/)).toBeVisible();
  const result = await ask(page, 'Application fee');
  await expect(result.locator('blockquote')).toHaveText('Application fee: Rs. 500');
  await result.getByRole('button', { name: 'Inspect source [1]' }).click();
  await page.getByText('Nearby extracted passages (same PDF page)').click();
  const panel = page.getByRole('region', { name: 'Source page inspection' });
  await expect(panel.getByText('Refund policy: No refunds', { exact: true })).toBeVisible();
  await expect(result.getByText('Refund policy: No refunds', { exact: true })).toHaveCount(0);
});


test('automatic scope answers separate versions and does not substitute a missing source', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', ['Application fee: Rs. 500']);
  await expect(page.getByText(/extracted passages available/)).toBeVisible();
  await page.getByLabel('Search scope').selectOption('auto');
  const missing = await ask(page, 'Application fee in updated notice?');
  await expect(missing.getByText(/Requested source not attached/)).toBeVisible();
  await expect(missing.locator('blockquote')).toHaveCount(0);
  await attach(page, 'Updated / second PDF', ['Application fee: Rs. 350']);
  await expect(page.getByText(/extracted passages available/)).toHaveCount(2);
  const result = await ask(page, 'Fee in first document? Fee in second version?');
  await expect(result.locator('.chat-answer').nth(0).locator('blockquote')).toHaveText('Application fee: Rs. 500');
  await expect(result.locator('.chat-answer').nth(1).locator('blockquote')).toHaveText('Application fee: Rs. 350');
});


test('nearby-line fallback shows separate source fragments and can be disabled', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', [
    'Applications from rural districts', 'must include a residence certificate',
  ]);
  await expect(page.getByText(/extracted passages available/)).toBeVisible();
  const result = await ask(page, 'Rural residence certificate');
  await expect(result.getByRole('heading', { name: 'Nearby matching fragments' })).toBeVisible();
  await expect(result.locator('blockquote')).toHaveText([
    'Applications from rural districts', 'must include a residence certificate',
  ]);
  await expect(result.getByText('Context fragment, not a standalone answer')).toHaveCount(2);
  await expect(result.getByRole('heading', { name: 'Printed values in matching passages' })).toHaveCount(0);
  await result.getByRole('button', { name: 'Inspect source [2]' }).click();
  await expect(page.getByRole('region', { name: 'Source page inspection' })).toBeVisible();
  await page.getByLabel('Search nearby lines when no single line matches').uncheck();
  const strict = await ask(page, 'Rural residence certificate');
  await expect(strict.getByRole('heading', { name: 'Insufficient matching evidence' })).toBeVisible();
  await expect(strict.locator('blockquote')).toHaveCount(0);
});


test('explicit physical page filter does not silently search other pages', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', ['Application fee: Rs. 500']);
  await expect(page.getByText(/extracted passages available/)).toBeVisible();
  const found = await ask(page, 'Application fee on page 1?');
  await expect(found.getByText(/Physical PDF page 1 only/)).toBeVisible();
  await expect(found.locator('blockquote')).toHaveText('Application fee: Rs. 500');
  const absent = await ask(page, 'Application fee on page 2?');
  await expect(absent.getByText(/Physical PDF page 2 only/)).toBeVisible();
  await expect(absent.getByRole('heading', { name: 'Insufficient matching evidence' })).toBeVisible();
  await expect(absent.locator('blockquote')).toHaveCount(0);
  await page.getByLabel('Your question').fill('Fee on pages 1-2');
  await page.getByRole('button', { name: 'Ask PDF' }).click();
  await expect(page.getByRole('alert')).toHaveText('Use one physical PDF page number from 1 to 80.');
});


test('page coverage distinguishes blank and nonexistent physical pages', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', []);
  await expect(page.getByText('Processed 1 of 1 physical PDF pages.', { exact: false })).toBeVisible();
  const blank = await ask(page, 'Application fee on page 1?');
  await expect(blank.getByText(/physical page 1 has no indexed text/)).toBeVisible();
  const absent = await ask(page, 'Application fee on page 2?');
  await expect(absent.getByText(/physical page 2 does not exist in this PDF/)).toBeVisible();
  const whole = await ask(page, 'Application fee');
  await expect(whole.getByText(/searchable text coverage is incomplete/)).toBeVisible();
  await expect(whole.locator('blockquote')).toHaveCount(0);
});


test('overview exposes recognized printed fields, aliases and page citations before chat', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', [
    'Last date to apply: 19 December 2026', 'Application fee: Rs. 500',
  ]);
  await attach(page, 'Updated / second PDF', [
    'Application closing date: 13 December 2026', 'Application charges: Rs. 350',
  ]);
  const overview = page.getByRole('region', { name: 'Document overview' });
  await expect(overview).toBeVisible();
  await expect(overview.getByText('2 recognized field categories.', { exact: false })).toBeVisible();
  const deadline = overview.locator('article').filter({ has: page.getByRole('heading', { name: 'Application deadline', exact: true }) });
  await expect(deadline.getByText('Different printed value text')).toBeVisible();
  await expect(deadline.getByText('19 December 2026')).toBeVisible();
  await expect(deadline.getByText('13 December 2026')).toBeVisible();
  await deadline.getByRole('button', { name: 'Inspect original page 1' }).click();
  await expect(page.getByRole('region', { name: 'Source page inspection' })).toBeVisible();
  await deadline.getByRole('button', { name: 'Ask about application deadline' }).click();
  await expect(page.getByLabel('Your question')).toHaveValue('Application deadline');
  await expect(page.getByLabel('Search scope')).toHaveValue('auto');
  await page.getByRole('button', { name: 'Ask PDF' }).click();
  await expect(page.locator('.chat-turn').last().locator('blockquote')).toHaveText([
    'Last date to apply: 19 December 2026', 'Application closing date: 13 December 2026',
  ]);
});
test('overview review filter preserves competing values and hides identical displayed fields', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', [
    'Application fee: Rs. 500', 'Eligibility: Class 12', 'Interview date: 21 December 2026',
  ]);
  await attach(page, 'Updated / second PDF', [
    'Application fee: Rs. 350', 'Application fee: Rs. 900', 'Eligibility: Class 12',
  ]);
  const overview = page.getByRole('region', { name: 'Document overview' });
  await expect(overview.getByRole('heading', { name: 'Eligibility', exact: true })).toBeVisible();
  await overview.getByLabel('Overview filter').selectOption('review');
  await expect(overview.getByRole('heading', { name: 'Eligibility', exact: true })).toHaveCount(0);
  await expect(overview.getByText(/More than one distinct value/)).toBeVisible();
  await expect(overview.getByText('Field found in one indexed source only')).toBeVisible();
  await page.getByRole('button', { name: 'Clear revised PDF' }).click();
  await expect(overview.getByText('Rs. 900', { exact: true })).toHaveCount(0);
});
