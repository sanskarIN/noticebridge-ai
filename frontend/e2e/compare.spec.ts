import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

// Fictional, generated PDF data: no real applicant details or official notices.
const originalPdf = Buffer.from('JVBERi0xLjcKJcK1wrYKCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nL1BhZ2VzIDIgMCBSPj4KZW5kb2JqCgoyIDAgb2JqCjw8L1R5cGUvUGFnZXMvQ291bnQgMS9LaWRzWzQgMCBSXT4+CmVuZG9iagoKMyAwIG9iago8PC9Gb250PDwvaGVsdiA1IDAgUj4+Pj4KZW5kb2JqCgo0IDAgb2JqCjw8L1R5cGUvUGFnZS9NZWRpYUJveFswIDAgNjEwIDgwMF0vUm90YXRlIDAvUmVzb3VyY2VzIDMgMCBSL1BhcmVudCAyIDAgUi9Db250ZW50c1s2IDAgUl0+PgplbmRvYmoKCjUgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhL0VuY29kaW5nL1dpbkFuc2lFbmNvZGluZz4+CmVuZG9iagoKNiAwIG9iago8PC9MZW5ndGggMTA5L0ZpbHRlci9GbGF0ZURlY29kZT4+CnN0cmVhbQp42hWJOwoCQRBE8z5F38D+zFQjiIGwiZnQ2bKB6CwGGph4fnsoXhXUoy9dkpSlogzhUOH80OE13j9WcO68npqGhOCBIxwarXbHMEFDh1ZPM9D9buLqbtKm8eIJQw+r33yC85ZXWpJu9AeuKBtxCmVuZHN0cmVhbQplbmRvYmoKCnhyZWYKMCA3CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNiAwMDAwMCBuIAowMDAwMDAwMDYyIDAwMDAwIG4gCjAwMDAwMDAxMTQgMDAwMDAgbiAKMDAwMDAwMDE1NSAwMDAwMCBuIAowMDAwMDAwMjYyIDAwMDAwIG4gCjAwMDAwMDAzNTEgMDAwMDAgbiAKCnRyYWlsZXIKPDwvU2l6ZSA3L1Jvb3QgMSAwIFIvSURbPEMyOUIyMEMyQjRDMkJDNTZDMzhBMkIxMjE4QzI4M0MyPjwxMUMwRDIyMDM3NzE0QkMxRjgyRDE0RDA3ODUxNUM1Mj5dPj4Kc3RhcnR4cmVmCjUyOQolJUVPRgo=', 'base64');
const revisedPdf = Buffer.from('JVBERi0xLjcKJcK1wrYKCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nL1BhZ2VzIDIgMCBSPj4KZW5kb2JqCgoyIDAgb2JqCjw8L1R5cGUvUGFnZXMvQ291bnQgMS9LaWRzWzQgMCBSXT4+CmVuZG9iagoKMyAwIG9iago8PC9Gb250PDwvaGVsdiA1IDAgUj4+Pj4KZW5kb2JqCgo0IDAgb2JqCjw8L1R5cGUvUGFnZS9NZWRpYUJveFswIDAgNjEwIDgwMF0vUm90YXRlIDAvUmVzb3VyY2VzIDMgMCBSL1BhcmVudCAyIDAgUi9Db250ZW50c1s2IDAgUl0+PgplbmRvYmoKCjUgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhL0VuY29kaW5nL1dpbkFuc2lFbmNvZGluZz4+CmVuZG9iagoKNiAwIG9iago8PC9MZW5ndGggMTA5L0ZpbHRlci9GbGF0ZURlY29kZT4+CnN0cmVhbQp42hWJOwoCQRBE8z5F38D+zFQjiIGwiZnQ2bKB6CwGGph4fnsoXhXUoy9dkpSlogzhUOH80OE13j9WcO68npqGhOCBIxwarXbHMEFDh1ZPM9D9buLqzaRN48UThh5Wv/kE5y2vtCTd6A+uTxtyCmVuZHN0cmVhbQplbmRvYmoKCnhyZWYKMCA3CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNiAwMDAwMCBuIAowMDAwMDAwMDYyIDAwMDAwIG4gCjAwMDAwMDAxMTQgMDAwMDAgbiAKMDAwMDAwMDE1NSAwMDAwMCBuIAowMDAwMDAwMjYyIDAwMDAwIG4gCjAwMDAwMDAzNTEgMDAwMDAgbiAKCnRyYWlsZXIKPDwvU2l6ZSA3L1Jvb3QgMSAwIFIvSURbPEMyQTk0MEMyQjAxMDREQzJBNDBFQzJBN0MyQTlDMzkzPjw2ODYzRjgyNDg2RjI0NzY1ODE0Q0Q3NDZFRDM3OEJERT5dPj4Kc3RhcnR4cmVmCjUyOQolJUVPRgo=', 'base64');

async function addSources(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.locator('#original').setInputFiles({
    name: 'original.pdf', mimeType: 'application/pdf', buffer: originalPdf,
  });
  await page.locator('#revised').setInputFiles({
    name: 'revised.pdf', mimeType: 'application/pdf', buffer: revisedPdf,
  });
}

test('shows evidence and locally renders a highlighted PDF.js page', async ({ page }) => {
  await addSources(page);
  await page.getByRole('button', { name: /Compare documents/ }).click();
  await expect(page.locator('.finding')).toHaveCount(1);
  await expect(page.getByText(/Document wording differs/)).toBeVisible();
  await page.getByRole('button', { name: /Open PDF page/ }).first().click();
  await expect(page.locator('.preview-dialog canvas')).toBeVisible();
  await expect.poll(() => page.locator('.preview-dialog canvas').evaluate(
    element => (element as HTMLCanvasElement).width
  )).toBeGreaterThan(0);
  await expect(page.locator('.evidence-highlight')).toBeVisible();
  await page.getByRole('button', { name: /Close preview/ }).click();
  await expect(page.locator('.preview-dialog')).toHaveCount(0);
});

test('exports source-bound evidence JSON and offers Hindi explanations', async ({ page }) => {
  await addSources(page);
  await page.getByRole('button', { name: /Compare documents/ }).click();
  await expect(page.locator('.finding')).toHaveCount(1);
  await page.getByRole('button', { name: 'हिंदी' }).click();
  await expect(page.getByText(/संबंधित स्रोत अंशों/)).toBeVisible();
  const promise = page.waitForEvent('download');
  await page.getByRole('button', { name: /प्रमाण रिपोर्ट डाउनलोड करें/ }).click();
  const download = await promise;
  const payload = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(payload.documents).toHaveLength(2);
  expect(payload.documents[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(payload.findings[0].authority_verified).toBe(false);
  expect(payload.findings[0].original.page).toBe(1);
});
