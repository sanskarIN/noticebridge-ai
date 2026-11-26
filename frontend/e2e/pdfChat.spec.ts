import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

function pdf(lines: string[]): Buffer {
  const stream = lines.map((line, i) =>
    'BT /F1 12 Tf 40 ' + (720 - i * 30) + ' Td (' + line + ') Tj ET\n',
  ).join('');
  return pdfStream(stream);
}
function pdfStream(stream: string): Buffer {
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
  const history = page.locator('.chat-turn');
  const count = await history.count();
  await page.getByLabel('Your question').fill(question);
  await page.getByRole('button', { name: 'Ask PDF' }).click();
  await expect(history).toHaveCount(count + 1);
  await expect(history.last().locator('.chat-user')).toContainText(question);
  return history.last();
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
  await page.getByLabel('Search scope', { exact: true }).selectOption('original');
  await ask(page, 'Application fee');
  await page.getByLabel('Search scope', { exact: true }).selectOption('revised');
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
  await page.getByLabel('Search scope', { exact: true }).selectOption('auto');
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
  await expect(page.getByLabel('Search scope', { exact: true })).toHaveValue('auto');
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


async function exportQuestions(page: Page) {
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export question plan JSON' }).click();
  const download = await waiting;
  return readFile((await download.path())!);
}

test('question plan exports pinned questions and replays answers with explicit confirmation', async ({ page }) => {
  const lines = ['Application fee: Rs. 500', 'Eligibility: Class 12'];
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', lines);
  await expect(page.getByText(/extracted passages available/)).toBeVisible();
  await ask(page, 'Application fee');
  await ask(page, 'Eligibility');
  const bytes = await exportQuestions(page);
  const raw = JSON.parse(bytes.toString());
  expect(raw.sources).toEqual({ original: createHash('sha256').update(pdf(lines)).digest('hex') });
  expect(raw.questions.map((item: {input: string}) => item.input)).toEqual(['Application fee', 'Eligibility']);
  expect(bytes.toString()).not.toContain('Rs. 500');
  expect(bytes.toString()).not.toContain('Class 12');
  await page.getByRole('button', { name: 'Clear conversation' }).click();
  await expect(page.locator('.chat-turn')).toHaveCount(0);
  await page.getByLabel('Replay saved question plan').setInputFiles({
    name: 'questions.json', mimeType: 'application/json', buffer: bytes,
  });
  await expect(page.getByRole('region', { name: 'Replay confirmation' })).toBeVisible();
  await expect(page.locator('.chat-turn')).toHaveCount(0);
  await page.getByRole('button', { name: 'Apply replayed conversation' }).click();
  await expect(page.locator('.chat-turn')).toHaveCount(2);
  await expect(page.locator('.chat-turn').nth(0).locator('blockquote')).toHaveText('Application fee: Rs. 500');
  await expect(page.locator('.chat-turn').nth(1).locator('blockquote')).toHaveText('Eligibility: Class 12');
});
test('question plan fails closed if the source PDF was replaced', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', ['Application fee: Rs. 500']);
  await expect(page.getByText(/extracted passages available/)).toBeVisible();
  await ask(page, 'Application fee');
  const bytes = await exportQuestions(page);
  await attach(page, 'Original / first PDF', ['Application fee: Rs. 350']);
  await expect(page.getByText(/extracted passages available/)).toBeVisible();
  await ask(page, 'Application fee');
  await page.getByLabel('Replay saved question plan').setInputFiles({
    name: 'questions.json', mimeType: 'application/json', buffer: bytes,
  });
  await expect(page.getByRole('alert')).toHaveText('The question plan requires the exact same attached PDF bytes and roles.');
  await expect(page.getByRole('region', { name: 'Replay confirmation' })).toHaveCount(0);
  await expect(page.locator('.chat-turn').last().locator('blockquote')).toHaveText('Application fee: Rs. 350');
});
test('pending replay is discarded when the source changes', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', ['Application fee: Rs. 500']);
  await expect(page.getByText(/extracted passages available/)).toBeVisible();
  await ask(page, 'Application fee');
  const bytes = await exportQuestions(page);
  await page.getByLabel('Replay saved question plan').setInputFiles({
    name: 'questions.json', mimeType: 'application/json', buffer: bytes,
  });
  await expect(page.getByRole('region', { name: 'Replay confirmation' })).toBeVisible();
  await attach(page, 'Original / first PDF', ['Application fee: Rs. 350']);
  await expect(page.getByText(/extracted passages available/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Replay confirmation' })).toHaveCount(0);
  await expect(page.locator('.chat-turn')).toHaveCount(0);
});


test('semantic file exchange is consented, source-scoped and never changes the baseline', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', ['Application fee: Rs. 500', 'Eligibility: Class 12']);
  await expect(page.getByText(/extracted passages available/)).toBeVisible();
  const result = await ask(page, 'Application fee');
  await expect(result.locator('blockquote')).toHaveText('Application fee: Rs. 500');
  await page.getByText('Experimental semantic retrieval (local file workflow)', { exact: true }).click();
  const exportButton = page.getByRole('button', { name: 'Export semantic retrieval request' });
  await expect(exportButton).toBeDisabled();
  await page.getByLabel('I understand that the exported request contains document text.').check();
  const waiting = page.waitForEvent('download');
  await exportButton.click();
  const file = await waiting;
  const data = await readFile((await file.path())!);
  const request = JSON.parse(data.toString());
  expect(request.passages.map((row: {id: string}) => row.id)).toEqual(['original:1:1', 'original:1:2']);
  const ranking = {
    format: 'noticebridge-chat-embedding-result', version: 1,
    request_sha256: createHash('sha256').update(data).digest('hex'),
    model: 'example-embedding:latest', model_digest: 'a'.repeat(64), dimension: 2, candidate_count: 2,
    ranks: { original: ['original:1:2', 'original:1:1'] }, authority_verified: false,
  };
  const input = page.getByLabel('Import local candidate ranking');
  await input.setInputFiles({
    name: 'ranking.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(ranking, null, 2) + '\n'),
  });
  const review = page.getByRole('region', { name: 'Experimental candidate review' });
  await expect(review.locator('blockquote')).toHaveText(['Application fee: Rs. 500', 'Eligibility: Class 12']);
  await expect(result.locator('blockquote')).toHaveText('Application fee: Rs. 500');
  await review.getByRole('button', { name: 'Inspect candidate source' }).nth(1).click();
  await expect(page.getByRole('region', { name: 'Source page inspection' })).toBeVisible();
  await ask(page, 'Eligibility');
  await expect(review).toHaveCount(0);
});


test('local model selection imports only complete candidate identities and preserves baseline', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', ['Application fee: Rs. 500', 'Application fee: Rs. 750']);
  await expect(page.getByText(/extracted passages available/)).toBeVisible();
  const answer = await ask(page, 'Application fee');
  await expect(answer.locator('blockquote')).toHaveText(['Application fee: Rs. 500', 'Application fee: Rs. 750']);
  await page.getByText('Experimental local AI selection (local file workflow)', { exact: true }).click();
  const button = page.getByRole('button', { name: 'Export evidence selection request' });
  await expect(button).toBeDisabled();
  await page.getByLabel('I approve exporting candidate text for local AI selection.').check();
  const waiting = page.waitForEvent('download');
  await button.click();
  const data = await readFile((await (await waiting).path())!);
  const request = JSON.parse(data.toString());
  expect(request.passages.map((row: {id: string}) => row.id)).toEqual(['original:1:1', 'original:1:2']);
  const proposal = {
    format: 'noticebridge-chat-selection-result', version: 1,
    request_sha256: createHash('sha256').update(data).digest('hex'),
    model: 'example-local:latest', model_digest: 'a'.repeat(64),
    selection: { status: 'select', ids: ['original:1:2'] },
    authority_verified: false,
  };
  const input = page.getByLabel('Import local AI selection');
  await input.setInputFiles({
    name: 'selection.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(proposal, null, 2) + '\n'),
  });
  const review = page.getByRole('region', { name: 'Local AI selection review' });
  await expect(review.locator('blockquote')).toHaveText('Application fee: Rs. 750');
  await expect(review.getByText(/did not select 1 baseline evidence fragments/)).toBeVisible();
  await expect(answer.locator('blockquote')).toHaveText(['Application fee: Rs. 500', 'Application fee: Rs. 750']);
  await review.getByRole('button', { name: 'Inspect selected source' }).click();
  await expect(page.getByRole('region', { name: 'Source page inspection' })).toBeVisible();
  await input.setInputFiles({
    name: 'selection.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...proposal, selection: { status: 'insufficient', ids: [] } }, null, 2) + '\n'),
  });
  await expect(review.getByRole('heading', { name: 'Local model abstained' })).toBeVisible();
  await expect(review.locator('blockquote')).toHaveCount(0);
  await expect(answer.locator('blockquote')).toHaveCount(2);
  await input.setInputFiles({
    name: 'selection.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...proposal, selection: { status: 'select', ids: ['revised:1:1'] } }, null, 2) + '\n'),
  });
  await expect(page.getByRole('alert')).toHaveText('Evidence selection rejected. Use the exact result for this request.');
  await expect(review).toHaveCount(0);
  await ask(page, 'Eligibility');
  await expect(review).toHaveCount(0);
});


test('concise field answer preserves all value counts and links to local source pages', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', [
    'Application fee: Rs. 500', 'Application fee: Rs. 600',
    'Application fee: Rs. 700', 'Application fee: Rs. 800', 'Application fee: Rs. 900',
  ]);
  await expect(page.getByText(/extracted passages available/)).toBeVisible();
  const answer = await ask(page, 'Application fee');
  const concise = answer.getByRole('region', { name: 'Concise printed-field answer' });
  await expect(concise.getByText('Multiple distinct printed values were found. No single value is chosen.')).toBeVisible();
  await expect(concise.getByText(/1 additional distinct printed values not displayed/)).toBeVisible();
  await expect(concise.getByText(/prints “Rs. 500”/)).toBeVisible();
  await concise.getByRole('button', { name: 'Read original page 1, fragment 1' }).click();
  await expect(page.getByRole('region', { name: 'Source page inspection' })).toBeVisible();
  await expect(answer.locator('blockquote')).toHaveCount(4);
  const qualified = await ask(page, 'Application fee for rural applicants');
  await expect(qualified.getByRole('region', { name: 'Concise printed-field answer' })).toHaveCount(0);
});


test('same-question replay with a different scope invalidates old model exchange', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', ['Application fee: Rs. 500']);
  await attach(page, 'Updated / second PDF', ['Application fee: Rs. 350']);
  await expect(page.getByText(/extracted passages available/)).toHaveCount(2);
  await page.getByLabel('Search scope', { exact: true }).selectOption('original');
  await ask(page, 'Application fee');
  const plan = JSON.parse((await exportQuestions(page)).toString());
  plan.questions[0].scope = 'revised';
  await page.getByText('Experimental semantic retrieval (local file workflow)', { exact: true }).click();
  await page.getByLabel('I understand that the exported request contains document text.').check();
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export semantic retrieval request' }).click();
  await waiting;
  await expect(page.getByLabel('Import local candidate ranking')).toBeEnabled();
  await page.getByLabel('Replay saved question plan').setInputFiles({
    name: 'questions.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(plan, null, 2) + '\n'),
  });
  await page.getByRole('button', { name: 'Apply replayed conversation' }).click();
  await expect(page.locator('.chat-turn').last().locator('blockquote')).toHaveText('Application fee: Rs. 350');
  await page.getByText('Experimental semantic retrieval (local file workflow)', { exact: true }).click();
  await expect(page.getByLabel('I understand that the exported request contains document text.')).not.toBeChecked();
  await expect(page.getByLabel('Import local candidate ranking')).toBeDisabled();
});


function categoryTablePdf(missing = false, changed = false): Buffer {
  const lines = [
    ['Category', 'Application fee', 'Examination fee'],
    ['General', changed ? 'Rs. 350' : 'Rs. 500', 'Rs. 800'],
    ['Reserved', missing ? '' : 'Rs. 250', 'Rs. 400'],
  ];
  const xs = [40, 220, 420];
  const stream = lines.flatMap((row, i) => row.flatMap((cell, j) => cell
    ? ['BT /F1 12 Tf ' + xs[j] + ' ' + (720 - i * 30) + ' Td (' + cell + ') Tj ET\n']
    : [])).join('');
  return pdfStream(stream);
}

test('independently positioned category-table cells retain separate indexed fragments', async ({ page }) => {
  await page.goto('/?view=chat');
  await page.getByLabel('Original / first PDF', { exact: true }).setInputFiles({
    name: 'separated-cells.pdf', mimeType: 'application/pdf', buffer: categoryTablePdf(),
  });
  // A PDF.js synthetic space must not conceal the wide inter-cell gap.
  await expect(page.getByText('9 extracted passages available.')).toBeVisible();
  await expect(page.getByText('1 aligned category table candidates.')).toBeVisible();
});

test('aligned PDF table supports category-specific questions and source inspection', async ({ page }) => {
  await page.goto('/?view=chat');
  await page.getByLabel('Original / first PDF', { exact: true }).setInputFiles({
    name: 'table.pdf', mimeType: 'application/pdf', buffer: categoryTablePdf(),
  });
  await expect(page.getByText('1 aligned category table candidates.')).toBeVisible();
  const answer = await ask(page, 'What is the application fee for Reserved category?');
  const table = answer.getByRole('region', { name: 'Aligned table evidence candidates' });
  await expect(table).toBeVisible();
  await expect(table.getByText('Rs. 250', { exact: true })).toBeVisible();
  await expect(table.getByText('Rs. 500', { exact: true })).toHaveCount(0);
  await expect(table.getByText('Rs. 400', { exact: true })).toHaveCount(0);
  await table.getByRole('button', { name: 'Inspect table candidate 1' }).click();
  await expect(page.getByRole('region', { name: 'Source page inspection' })).toBeVisible();
  const other = await ask(page, 'Examination fee for General');
  await expect(other.getByRole('region', { name: 'Aligned table evidence candidates' }).getByText('Rs. 800', { exact: true })).toBeVisible();
});
test('an incomplete PDF table is not promoted to a category answer', async ({ page }) => {
  await page.goto('/?view=chat');
  await page.getByLabel('Original / first PDF', { exact: true }).setInputFiles({
    name: 'table.pdf', mimeType: 'application/pdf', buffer: categoryTablePdf(true),
  });
  await expect(page.getByText(/extracted passages available/)).toBeVisible();
  const answer = await ask(page, 'Application fee for Reserved');
  await expect(answer.getByRole('region', { name: 'Aligned table evidence candidates' })).toHaveCount(0);
});
test('table values are source-scoped and never silently choose one version', async ({ page }) => {
  await page.goto('/?view=chat');
  await page.getByLabel('Original / first PDF', { exact: true }).setInputFiles({
    name: 'first.pdf', mimeType: 'application/pdf', buffer: categoryTablePdf(),
  });
  await page.getByLabel('Updated / second PDF', { exact: true }).setInputFiles({
    name: 'second.pdf', mimeType: 'application/pdf', buffer: categoryTablePdf(false, true),
  });
  await expect(page.getByText('1 aligned category table candidates.')).toHaveCount(2);
  await page.getByLabel('Search scope', { exact: true }).selectOption('both');
  const answer = await ask(page, 'Application fee for General');
  const table = answer.getByRole('region', { name: 'Aligned table evidence candidates' });
  await expect(table.getByText('Rs. 500', { exact: true })).toBeVisible();
  await expect(table.getByText('Rs. 350', { exact: true })).toBeVisible();
  await page.getByLabel('Search scope', { exact: true }).selectOption('revised');
  const selected = await ask(page, 'Application fee for General');
  const scoped = selected.getByRole('region', { name: 'Aligned table evidence candidates' });
  await expect(scoped.getByText('Rs. 350', { exact: true })).toBeVisible();
  await expect(scoped.getByText('Rs. 500', { exact: true })).toHaveCount(0);
});


test('table explorer offers source-scoped guided questions without submitting automatically', async ({ page }) => {
  await page.goto('/?view=chat');
  await page.getByLabel('Updated / second PDF', { exact: true }).setInputFiles({
    name: 'second.pdf', mimeType: 'application/pdf', buffer: categoryTablePdf(false, true),
  });
  await expect(page.getByText('1 aligned category table candidates.')).toBeVisible();
  await page.getByText('Explore aligned category tables (1)', { exact: true }).click();
  const table = page.getByRole('region', { name: 'Aligned category table preview' });
  await expect(table.getByRole('columnheader', { name: /Application fee/ })).toBeVisible();
  await expect(table.getByRole('rowheader', { name: /Reserved/ })).toBeVisible();
  await table.getByRole('button', { name: 'Ask Application fee for Reserved' }).click();
  await expect(page.getByLabel('Your question')).toHaveValue('Application fee for Reserved on page 1?');
  await expect(page.getByLabel('Search scope', { exact: true })).toHaveValue('revised');
  await expect(page.locator('.chat-turn')).toHaveCount(0);
  await page.getByRole('button', { name: 'Ask PDF' }).click();
  await expect(page.locator('.chat-turn').last().getByRole('region', { name: 'Aligned table evidence candidates' }).getByText('Rs. 250', { exact: true })).toBeVisible();
});

function twoPageEvidencePdf(): Buffer {
  const streams = [
    'BT /F1 12 Tf 40 720 Td (Applicants from rural districts) Tj ET\n',
    'BT /F1 12 Tf 40 720 Td (A residence certificate must be submitted) Tj ET\n',
  ];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
    ...[6, 7].map(id => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents ' + id + ' 0 R >>'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...streams.map(stream => '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + 'endstream'),
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(body));
    body += (i + 1) + ' 0 obj\n' + object + '\nendobj\n';
  });
  const xref = Buffer.byteLength(body);
  body += 'xref\n0 8\n0000000000 65535 f \n';
  for (const offset of offsets) body += String(offset).padStart(10, '0') + ' 00000 n \n';
  body += 'trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(body);
}

test('cross-page leads require explicit exploration and preserve the strict abstention', async ({ page }) => {
  await page.goto('/?view=chat');
  await page.getByLabel('Original / first PDF', { exact: true }).setInputFiles({
    name: 'fictional-two-page.pdf', mimeType: 'application/pdf', buffer: twoPageEvidencePdf(),
  });
  await expect(page.getByText('2 extracted passages available.')).toBeVisible();
  const answer = await ask(page, 'Rural residence certificate?');
  await expect(answer.getByRole('heading', { name: 'Insufficient matching evidence' })).toBeVisible();
  const region = answer.getByRole('region', { name: 'Cross-page evidence exploration' });
  await expect(region.getByText('“Applicants from rural districts”')).toHaveCount(0);
  await region.getByRole('button', { name: 'Search across pages' }).click();
  await expect(region.getByText('“Applicants from rural districts”')).toBeVisible();
  await expect(region.getByText('“A residence certificate must be submitted”')).toBeVisible();
  await expect(answer.getByRole('heading', { name: 'Insufficient matching evidence' })).toBeVisible();
  await expect(answer.locator('blockquote')).toHaveCount(0);
  await region.getByRole('button', { name: 'Inspect cross-page lead on page 2' }).click();
  await expect(page.getByRole('region', { name: 'Source page inspection' }).getByRole('heading', { name: /page 2/ })).toBeVisible();
  const scoped = await ask(page, 'Rural residence certificate on page 1?');
  await expect(scoped.getByRole('region', { name: 'Cross-page evidence exploration' })).toHaveCount(0);
});

test('private chat evidence export requires consent and verifies without importing answers', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', ['Application fee: Rs. 500']);
  await expect(page.getByText('1 extracted passages available.')).toBeVisible();
  await ask(page, 'Application fee?');
  await page.getByText('Export or verify a private evidence report', { exact: true }).click();
  const button = page.getByRole('button', { name: 'Export evidence report JSON' });
  await expect(button).toBeDisabled();
  await page.getByLabel('I understand this export includes source quotations.').check();
  const waiting = page.waitForEvent('download');
  await button.click();
  const download = await waiting;
  const data = await readFile((await download.path())!);
  const raw = JSON.parse(data.toString('utf8'));
  expect(raw.turns[0].answers[0].citations[0].text).toBe('Application fee: Rs. 500');
  expect(raw.authority_verified).toBe(false);
  await page.getByLabel('Verify saved evidence report').setInputFiles({
    name: 'report.json', mimeType: 'application/json', buffer: data,
  });
  await expect(page.getByText('Exact deterministic replay matched.')).toBeVisible();
  await expect(page.locator('.chat-turn')).toHaveCount(1);
  raw.turns[0].answers[0].citations[0].text = 'Application fee: free';
  await page.getByLabel('Verify saved evidence report').setInputFiles({
    name: 'tampered.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(raw, null, 2) + '\n'),
  });
  await expect(page.getByText(/Evidence or extraction coverage differs/)).toBeVisible();
  await expect(page.locator('.chat-turn')).toHaveCount(1);
  await expect(page.locator('.chat-turn').last().locator('blockquote')).toHaveText('Application fee: Rs. 500');
});

test('OCR review is fingerprint-bound, separate from native answers and source inspection context', async ({ page }) => {
  const source = pdf(['Fictional image-only content marker']);
  const ocr = {
    format: 'noticebridge-chat-ocr-review', version: 1,
    source_sha256: createHash('sha256').update(source).digest('hex'),
    role: 'original', page_count: 1,
    pages: [{ page: 1, status: 'ok', lines: [{ ordinal: 1, text: 'Application fee: Rs. 500' }] }],
  };
  await page.goto('/?view=chat');
  await page.getByLabel('Original / first PDF', { exact: true }).setInputFiles({
    name: 'fictional.pdf', mimeType: 'application/pdf', buffer: source,
  });
  await expect(page.getByText('1 extracted passages available.')).toBeVisible();
  const answer = await ask(page, 'Application fee?');
  await expect(answer.getByRole('heading', { name: 'Insufficient matching evidence' })).toBeVisible();
  await page.getByText('Experimental scanned PDF review (local OCR)', { exact: true }).click();
  const importFile = page.getByLabel('Import local OCR review report');
  await importFile.setInputFiles({
    name: 'ocr.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(ocr, null, 2) + '\n'),
  });
  const region = page.getByRole('region', { name: 'OCR review matches' });
  await expect(region.getByText('“Application fee: Rs. 500”')).toBeVisible();
  await expect(answer.locator('blockquote')).toHaveCount(0);
  await region.getByRole('button', { name: 'Inspect original OCR page 1' }).click();
  const inspection = page.getByRole('region', { name: 'Source page inspection' });
  await expect(inspection.getByText(/Unverified OCR transcription/)).toBeVisible();
  await expect(inspection.getByText('Nearby extracted passages (same PDF page)')).toHaveCount(0);
  await importFile.setInputFiles({
    name: 'bad.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...ocr, source_sha256: '0'.repeat(64) }, null, 2) + '\n'),
  });
  await expect(page.getByText(/OCR report is invalid or belongs/)).toBeVisible();
  await expect(region.getByText('“Application fee: Rs. 500”')).toBeVisible();
  await attach(page, 'Original / first PDF', ['Different PDF']);
  await expect(page.getByText('1 extracted passages available.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'OCR review matches' })).toHaveCount(0);
});

test('extractive model proposal highlights exact source substring without changing the baseline answer', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', ['Application fee: Rs. 500 unless exempt.']);
  await expect(page.getByText('1 extracted passages available.')).toBeVisible();
  const answer = await ask(page, 'Application fee?');
  await page.getByText('Experimental local AI extractive answer (local file workflow)', { exact: true }).click();
  const button = page.getByRole('button', { name: 'Export extractive proposal request' });
  await expect(button).toBeDisabled();
  await page.getByLabel('I approve exporting candidate text for local extractive proposals.').check();
  const waiting = page.waitForEvent('download');
  await button.click();
  const data = await readFile((await (await waiting).path())!);
  const request = JSON.parse(data.toString('utf8'));
  const start = request.passages[0].text.indexOf('Rs. 500');
  const result = {
    format: 'noticebridge-chat-extractive-result', version: 1,
    request_sha256: createHash('sha256').update(data).digest('hex'),
    model: 'fixture:latest', model_digest: 'a'.repeat(64),
    proposal: { status: 'extract', spans: [{ id: request.passages[0].id, start, end: start + 7 }] },
    authority_verified: false,
  };
  const input = page.getByLabel('Import local extractive proposal');
  await input.setInputFiles({ name: 'proposal.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(result, null, 2) + '\n') });
  const review = page.getByRole('region', { name: 'Extractive proposal review' });
  await expect(review.locator('mark')).toHaveText('Rs. 500');
  await expect(review.locator('blockquote')).toHaveText('Application fee: Rs. 500 unless exempt.');
  await expect(answer.locator('blockquote')).toHaveText('Application fee: Rs. 500 unless exempt.');
  await review.getByRole('button', { name: 'Inspect extractive source page 1' }).click();
  await expect(page.getByRole('region', { name: 'Source page inspection' })).toBeVisible();
  result.proposal.spans[0].end = 999;
  await input.setInputFiles({ name: 'bad.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(result, null, 2) + '\n') });
  await expect(page.getByText(/Extractive result rejected/)).toBeVisible();
  await expect(review).toHaveCount(0);
  await ask(page, 'Eligibility?');
  await expect(review).toHaveCount(0);
});

test('manual evidence explorer finds exact phrases and explicit references without changing conversation', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', ['Clause 4.2: Application fee Rs. 500', 'Clause 4.20: Application fee Rs. 750']);
  await expect(page.getByText('2 extracted passages available.')).toBeVisible();
  await page.getByText('Explore indexed PDF evidence', { exact: true }).click();
  await page.getByLabel('Evidence search mode').selectOption('reference');
  await page.getByLabel('Evidence search text').fill('Clause 4.2');
  await page.getByRole('button', { name: 'Search indexed evidence' }).click();
  const results = page.locator('.chat-explorer-results');
  await expect(results.locator('mark')).toHaveText('Clause 4.2');
  await expect(results.getByText(/1 matching indexed fragments/)).toBeVisible();
  await expect(results.getByText(/Rs. 750/)).toHaveCount(0);
  await results.getByRole('button', { name: 'Inspect original page 1, fragment 1' }).click();
  await expect(page.getByRole('region', { name: 'Source page inspection' })).toBeVisible();
  await page.getByLabel('Evidence search mode').selectOption('literal');
  await page.getByLabel('Evidence search text').fill('APPLICATION FEE');
  await page.getByRole('button', { name: 'Search indexed evidence' }).click();
  await expect(results.getByText(/2 matching indexed fragments/)).toBeVisible();
  await expect(page.locator('.chat-turn')).toHaveCount(0);
  await page.getByLabel('Evidence source filter').selectOption('revised');
  await page.getByRole('button', { name: 'Search indexed evidence' }).click();
  await expect(results.getByText(/0 matching indexed fragments/)).toBeVisible();
});
test('question evidence explorer exposes all strict matches without changing baseline citations', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', Array.from({ length: 14 }, (_, i) => 'Application fee: Rs. ' + (500 + i)));
  await expect(page.getByText('14 extracted passages available.')).toBeVisible();
  const answer = await ask(page, 'Application fee?');
  const region = answer.getByRole('region', { name: 'Explore question evidence' });
  await region.getByRole('button', { name: 'Show all strict matching passages' }).click();
  await expect(region.getByText(/14 matching indexed fragments/)).toBeVisible();
  await expect(region.locator('.chat-citation')).toHaveCount(12);
  await region.getByRole('button', { name: 'Next results' }).click();
  await expect(region.locator('.chat-citation')).toHaveCount(2);
  await expect(answer.locator('blockquote')).toHaveCount(4);
  await region.getByRole('button', { name: 'Previous results' }).click();
  await expect(region.locator('.chat-citation')).toHaveCount(12);
});

test('coverage navigator opens an empty PDF page without needing a chat citation', async ({ page }) => {
  await page.goto('/?view=chat');
  await page.getByLabel('Original / first PDF', { exact: true }).setInputFiles({
    name: 'blank.pdf', mimeType: 'application/pdf', buffer: pdf([]),
  });
  await expect(page.getByText('0 extracted passages available.')).toBeVisible();
  await page.getByText('Inspect PDF page coverage', { exact: true }).click();
  const button = page.getByRole('button', { name: 'Inspect original physical page 1: No indexed text' });
  await expect(button).toBeVisible();
  await button.click();
  const inspector = page.getByRole('region', { name: 'Source page inspection' });
  await expect(inspector.getByText(/No particular source fragment is selected/)).toBeVisible();
  await expect(inspector.getByText('Source page shown for manual inspection.')).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Previous PDF page' })).toBeDisabled();
  await expect(inspector.getByRole('button', { name: 'Next PDF page' })).toBeDisabled();
  await expect(inspector.locator('blockquote')).toHaveCount(0);
  await expect(page.locator('.chat-turn')).toHaveCount(0);
});
test('manual page navigation removes the previous quote and preserves the actual question answer', async ({ page }) => {
  await page.goto('/?view=chat');
  await page.getByLabel('Original / first PDF', { exact: true }).setInputFiles({
    name: 'two-pages.pdf', mimeType: 'application/pdf', buffer: twoPageEvidencePdf(),
  });
  await expect(page.getByText('2 extracted passages available.')).toBeVisible();
  const answer = await ask(page, 'Rural applicants?');
  await answer.getByRole('button', { name: 'Inspect source [1]' }).click();
  const inspector = page.getByRole('region', { name: 'Source page inspection' });
  await expect(inspector.locator('blockquote')).toHaveText('Applicants from rural districts');
  await inspector.getByRole('button', { name: 'Next PDF page' }).click();
  await expect(inspector.getByRole('heading', { name: /page 2/ })).toBeVisible();
  await expect(inspector.locator('blockquote')).toHaveCount(0);
  await expect(answer.locator('blockquote')).toHaveText('Applicants from rural districts');
  await inspector.getByRole('button', { name: 'Previous PDF page' }).click();
  await expect(inspector.getByRole('heading', { name: /page 1/ })).toBeVisible();
  await expect(inspector.locator('blockquote')).toHaveCount(0);
});
test('manual evidence source filter and question scope remain independent', async ({ page }) => {
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', ['Application fee: Rs. 500']);
  await expect(page.getByText('1 extracted passages available.')).toBeVisible();
  await page.getByText('Explore indexed PDF evidence', { exact: true }).click();
  await page.getByLabel('Evidence source filter').selectOption('revised');
  await expect(page.getByLabel('Search scope', { exact: true })).toHaveValue('original');
  await expect(page.getByLabel('Search scope')).toHaveCount(1);
  const result = await ask(page, 'Application fee');
  await expect(result.locator('blockquote')).toHaveText('Application fee: Rs. 500');
});

test('workspace panel keys remain distinct after adding a second chat turn', async ({ page }) => {
  const keyWarnings: string[] = [];
  page.on('console', message => {
    if (/same key|unique.*key|duplicate key/i.test(message.text())) keyWarnings.push(message.text());
  });
  await page.goto('/?view=chat');
  await attach(page, 'Original / first PDF', ['Application fee: Rs. 500', 'Eligibility: Class 12']);
  await expect(page.getByText('2 extracted passages available.')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Search scope', exact: true })).toHaveCount(1);
  await ask(page, 'Application fee');
  await page.getByText('Experimental semantic retrieval (local file workflow)', { exact: true }).click();
  await page.getByLabel('I understand that the exported request contains document text.').check();
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export semantic retrieval request' }).click();
  const data = await readFile((await (await waiting).path())!);
  const result = {
    format: 'noticebridge-chat-embedding-result', version: 1,
    request_sha256: createHash('sha256').update(data).digest('hex'),
    model: 'fixture:latest', model_digest: 'a'.repeat(64), dimension: 2, candidate_count: 2,
    ranks: { original: ['original:1:1', 'original:1:2'] }, authority_verified: false,
  };
  await page.getByLabel('Import local candidate ranking').setInputFiles({
    name: 'ranking.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(result, null, 2) + '\n'),
  });
  await expect(page.getByRole('region', { name: 'Experimental candidate review' })).toBeVisible();
  await ask(page, 'Eligibility');
  await expect(page.getByRole('region', { name: 'Experimental candidate review' })).toHaveCount(0);
  await expect(page.getByText('Experimental semantic retrieval (local file workflow)', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Export or verify a private evidence report', { exact: true })).toHaveCount(1);
  await page.getByText('Experimental semantic retrieval (local file workflow)', { exact: true }).click();
  await expect(page.getByLabel('Import local candidate ranking')).toBeDisabled();
  expect(keyWarnings).toEqual([]);
});
