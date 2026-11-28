import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('static showcase opens the evidence and exports a labeled report without an API', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const apiCalls: string[] = [];
  await page.route('**/api/**', route => {
    apiCalls.push(route.request().url());
    return route.abort();
  });
  await page.goto('./');
  await expect(page.getByRole('button', { name: /Compare documents/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try a fictional notice' }).click();
  await expect(page.getByText('Saved comparison from the NoticeBridge engine · Fictional notices')).toBeVisible();
  await page.getByRole('button', { name: /Inspect finding: Deadline moved 6 days earlier/ }).click();
  const target = page.locator('#finding-f1');
  await expect(target).toBeFocused();
  await target.getByRole('button', { name: /Open PDF page/ }).last().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.evidence-highlight')).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole('button', { name: /Close preview/ })).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Escape');
  await target.getByRole('button', { name: 'Compare source pages' }).click();
  await expect(dialog.locator('.evidence-highlight')).toHaveCount(2);
  await expect(dialog.locator('.preview-quote')).toHaveText([
    'Application deadline: 19 December 2026', 'Application deadline: 13 December 2026',
  ]);
  await page.keyboard.press('Escape');
  await target.getByRole('checkbox').check();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export evidence report/ }).click();
  const report = JSON.parse(await readFile(await (await downloadReady).path(), 'utf8'));
  expect(report.comparison_source).toBe('showcase');
  expect(report.automatic_ocr).toBe(false);
  expect(report.review).toEqual(['f1']);
  expect(report.documents).toHaveLength(2);
  expect(apiCalls).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321);
});


test('static showcase provides local PDF chat with page citations and no API', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/api/**', route => {
    requests.push(route.request().url());
    return route.abort();
  });
  await page.goto('./');
  await page.getByRole('link', { name: 'Chat with PDFs' }).click();
  await expect(page.getByRole('heading', { name: 'Chat with your PDFs' })).toBeVisible();
  await page.getByRole('button', { name: 'Try fictional notices' }).click();
  await expect(page.getByText(/extracted passages available/)).toHaveCount(2);
  await page.getByLabel('Your question').fill('What is the application fee?');
  await page.getByRole('button', { name: 'Ask PDF' }).click();
  await expect(page.locator('.chat-citation blockquote')).toHaveText([
    'Application fee: Rs. 500', 'Application fee: Rs. 350',
  ]);
  await page.getByRole('button', { name: 'Inspect source [1]', exact: true }).click();
  await expect(page.getByText('Source page shown for manual inspection.')).toBeVisible();
  expect(requests).toEqual([]);
  await page.getByRole('link', { name: 'Return to comparison' }).click();
  await expect(page.getByRole('button', { name: 'Try a fictional notice' })).toBeVisible();
});
