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
