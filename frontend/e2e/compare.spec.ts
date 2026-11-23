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


test('keeps experimental local AI opt-in and submits only on explicit choice', async ({ page }) => {
  await addSources(page);
  const aiToggle = page.getByLabel(/Suggest matches with local AI/);
  await expect(aiToggle).not.toBeChecked();
  await aiToggle.check();
  const responsePromise = page.waitForResponse(response =>
    response.url().endsWith('/api/compare') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: /Compare documents/ }).click();
  const response = await responsePromise;
  expect((await response.json()).semantic_assistance).toBe('no_candidates');
  await expect(page.getByText(/No unmatched category-labeled passages/)).toBeVisible();
  await expect(page.locator('.finding')).toHaveCount(1);
});


function widePagePdf(day: number): Buffer {
  // Tiny fictional native-text PDF with a deliberately large page.
  const stream = `BT /F1 24 Tf 80 3900 Td (Deadline: ${day} December 2026) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 4000 4000] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('bounds physical PDF canvas pixels on a high-resolution screen', async ({ browser }) => {
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    baseURL: 'http://127.0.0.1:5173',
  });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await page.locator('#original').setInputFiles({
      name: 'wide-original.pdf', mimeType: 'application/pdf', buffer: widePagePdf(13),
    });
    await page.locator('#revised').setInputFiles({
      name: 'wide-revised.pdf', mimeType: 'application/pdf', buffer: widePagePdf(14),
    });
    await page.getByRole('button', { name: /Compare documents/ }).click();
    await expect(page.locator('.finding')).toHaveCount(1);
    await page.getByRole('button', { name: /Open PDF page/ }).first().click();
    const canvas = page.locator('.preview-dialog canvas');
    await expect(canvas).toBeVisible();
    await expect(page.locator('.evidence-highlight')).toBeVisible();
    const dimensions = await canvas.evaluate(el => ({
      width: (el as HTMLCanvasElement).width,
      height: (el as HTMLCanvasElement).height,
    }));
    expect(dimensions.width * dimensions.height).toBeLessThanOrEqual(9_000_000);
    expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(4096);
  } finally {
    await context.close();
  }
});

test('source preview traps keyboard focus, closes on Escape and restores focus', async ({ page }) => {
  await addSources(page);
  await page.getByRole('button', { name: /Compare documents/ }).click();
  await expect(page.locator('.finding')).toHaveCount(1);
  const launch = page.getByRole('button', { name: /Open PDF page/ }).first();
  await launch.focus();
  await launch.click();
  const dialog = page.getByRole('dialog');
  const close = dialog.getByRole('button', { name: /Close preview/ });
  await expect(close).toBeFocused();
  await expect(page.locator('main')).toHaveAttribute('inert', '');
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('link', { name: /Open PDF in new tab/ })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(launch).toBeFocused();
  await expect(page.locator('main')).not.toHaveAttribute('inert');
});

test('mobile comparison stays within viewport and discloses temporary storage', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    baseURL: 'http://127.0.0.1:5173',
  });
  try {
    const page = await context.newPage();
    await addSources(page);
    await expect(page.getByText(/temporary OS storage/)).toBeVisible();
    await page.getByRole('button', { name: /Compare documents/ }).click();
    await expect(page.locator('.finding')).toHaveCount(1);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: /Open PDF page/ }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'हिंदी' }).click();
    await expect(page.getByText(/अस्थायी सिस्टम स्टोरेज/)).toBeVisible();
  } finally {
    await context.close();
  }
});


function geometryPdf(day: number, rotation: 0 | 90 | 180 | 270, crop: boolean, unit: number): Buffer {
  // Fictional PDF using PDF-level /Rotate, /CropBox and /UserUnit.
  const stream = 'BT /F1 18 Tf 160 530 Td (Deadline: ' + day + ' December 2026) Tj ET\n';
  const media = '/MediaBox [0 0 600 800]';
  const cropBox = crop ? '/CropBox [100 100 500 700]' : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R ' + media + ' ' + cropBox + ' /Rotate ' + rotation +
      ' /UserUnit ' + unit + ' /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + 'endstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  }
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) +
    ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf);
}

for (const setting of [
  { rotation: 0 as const, crop: false, unit: 1 },
  { rotation: 90 as const, crop: false, unit: 1 },
  { rotation: 180 as const, crop: true, unit: 1 },
  { rotation: 270 as const, crop: true, unit: 2 },
]) {
  test('source highlight follows rotation ' + setting.rotation +
    ' crop ' + setting.crop + ' user unit ' + setting.unit, async ({ page }) => {
    await page.goto('/');
    await page.locator('#original').setInputFiles({
      name: 'geometry-original.pdf', mimeType: 'application/pdf',
      buffer: geometryPdf(13, setting.rotation, setting.crop, setting.unit),
    });
    await page.locator('#revised').setInputFiles({
      name: 'geometry-revised.pdf', mimeType: 'application/pdf',
      buffer: geometryPdf(14, setting.rotation, setting.crop, setting.unit),
    });
    await page.getByRole('button', { name: /Compare documents/ }).click();
    await expect(page.locator('.finding')).toHaveCount(1);
    await page.getByRole('button', { name: /Open PDF page/ }).first().click();
    await expect(page.locator('.preview-dialog canvas')).toBeVisible();
    const marker = page.locator('.evidence-highlight');
    await expect(marker).toBeVisible();
    const geometry = await page.evaluate(() => {
      const canvas = document.querySelector('.preview-dialog canvas')!.getBoundingClientRect();
      const mark = document.querySelector('.evidence-highlight')!.getBoundingClientRect();
      return {
        width: mark.width, height: mark.height,
        inside: mark.left >= canvas.left - 2 && mark.top >= canvas.top - 2 &&
          mark.right <= canvas.right + 2 && mark.bottom <= canvas.bottom + 2,
      };
    });
    expect(geometry.width).toBeGreaterThan(0);
    expect(geometry.height).toBeGreaterThan(0);
    expect(geometry.inside).toBe(true);
  });
}

test('refuses a source marker when reported PDF page geometry is inconsistent', async ({ page }) => {
  await page.route('**/api/compare', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.findings[0].original.page_width = 9999;
    await route.fulfill({ response, json: data });
  });
  await addSources(page);
  await page.getByRole('button', { name: /Compare documents/ }).click();
  await expect(page.locator('.finding')).toHaveCount(1);
  await page.getByRole('button', { name: /Open PDF page/ }).first().click();
  await expect(page.locator('.preview-dialog canvas')).toBeVisible();
  await expect(page.getByText(/geometry could not be verified/)).toBeVisible();
  await expect(page.locator('.evidence-highlight')).toHaveCount(0);
});


test('dark theme displays readable text extraction and local AI status panels', async ({ page }) => {
  await addSources(page);
  await page.getByLabel(/Suggest matches with local AI/).check();
  await page.getByRole('button', { name: /Compare documents/ }).click();
  const coverage = page.locator('.coverage-report');
  const modelFeedback = page.locator('.ai-feedback');
  await expect(coverage).toBeVisible();
  await expect(modelFeedback).toBeVisible();

  async function contrastRatio(selector: string): Promise<number> {
    return page.locator(selector).first().evaluate((element) => {
      const panel = element.closest('.coverage-report, .ai-feedback') ?? element;
      const background = getComputedStyle(panel).backgroundColor;
      const foreground = getComputedStyle(element).color;
      const channels = (color: string) =>
        [...color.matchAll(/[0-9]+(?:\.[0-9]+)?/g)]
          .slice(0, 3).map(match => Number(match[0]) / 255);
      const luminance = (color: string) => {
        const [r, g, b] = channels(color).map(value =>
          value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
        );
        return r * 0.2126 + g * 0.7152 + b * 0.0722;
      };
      const a = luminance(background);
      const b = luminance(foreground);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
  }

  expect(await contrastRatio('.coverage-report p')).toBeGreaterThanOrEqual(4.5);
  expect(await contrastRatio('.ai-feedback')).toBeGreaterThanOrEqual(4.5);
});


test('Hindi review localizes category, status, value, and source action labels', async ({ page }) => {
  await addSources(page);
  const hindi = page.getByRole('button', { name: 'हिंदी' });
  await hindi.click();
  await expect(hindi).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'EN' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('heading', { name: 'दस्तावेज़ तुलना' })).toBeVisible();
  await expect(page.getByText('↻ बदलें')).toHaveCount(2);
  await page.getByRole('button', { name: /दस्तावेज़ों की तुलना करें/ }).click();
  await expect(page.locator('.finding')).toHaveCount(1);
  await expect(page.locator('.finding .status')).toHaveText('पाठ में बदलाव');
  await expect(page.locator('.finding .category')).toHaveText('अंतिम तिथि');
  await expect(page.locator('.value-outcome')).toContainText('तिथि: बदला');
  await expect(page.locator('.checklist-item')).toContainText('अंतिम तिथि संबंधी कथन');
});


test('exports an Excel-compatible evidence and review CSV without asserting official authority', async ({ page }) => {
  await addSources(page);
  await page.getByRole('button', { name: /Compare documents/ }).click();
  await expect(page.locator('.finding')).toHaveCount(1);
  await page.locator('.checklist-item input').first().check();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export review CSV/ }).click();
  const download = await downloadReady;
  expect(download.suggestedFilename()).toBe('noticebridge-review.csv');
  const csv = await readFile(await download.path(), 'utf8');
  expect(csv.startsWith('\uFEFF')).toBe(true);
  const rows = csv.slice(1).trim().split('\r\n');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain('"original_sha256"');
  expect(rows[0]).toContain('"supporting_evidence_json"');
  expect(rows[1]).toContain('"yes","yes","no"');
  expect(rows[1]).toMatch(/[0-9a-f]{64}/);
  expect(rows[1]).toContain('December 2026');
});

test('CSV export neutralizes formulas from untrusted notice quotations and summaries', async ({ page }) => {
  await page.route('**/api/compare', async (route) => {
    const response = await route.fetch();
    const report = await response.json();
    report.findings[0].original.text = '=HYPERLINK("https://example.invalid")';
    report.findings[0].summary_en = '@SUM(1)';
    report.findings[0].summary_hi = '\t=2+2';
    await route.fulfill({ response, json: report });
  });
  await addSources(page);
  await page.getByRole('button', { name: /Compare documents/ }).click();
  await expect(page.locator('.finding')).toHaveCount(1);
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export review CSV/ }).click();
  const csv = await readFile(await (await downloadReady).path(), 'utf8');
  expect(csv).toContain("\"'=HYPERLINK(\"\"https://example.invalid\"\")\"");
  expect(csv).toContain("\"'@SUM(1)\"");
  expect(csv).toContain("\"'\t=2+2\"");
  expect(csv).not.toContain("\"=HYPERLINK(");
  expect(csv).not.toContain("\"@SUM(");
});

test('Hindi review CSV is downloadable without a mobile horizontal overflow', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    baseURL: 'http://127.0.0.1:5173',
  });
  try {
    const page = await context.newPage();
    await addSources(page);
    await page.getByRole('button', { name: 'हिंदी' }).click();
    await page.getByRole('button', { name: /दस्तावेज़ों की तुलना करें/ }).click();
    const downloadReady = page.waitForEvent('download');
    await page.getByRole('button', { name: /समीक्षा CSV डाउनलोड करें/ }).click();
    const csv = await readFile(await (await downloadReady).path(), 'utf8');
    expect(csv).toContain('अंतिम तिथि');
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
  }
});


test('changing OCR or local AI options invalidates stale evidence and review exports', async ({ page }) => {
  await addSources(page);
  await page.getByRole('button', { name: /Compare documents/ }).click();
  await expect(page.locator('.finding')).toHaveCount(1);
  await page.locator('.checklist-item input').first().check();
  await expect(page.getByRole('button', { name: /Export review CSV/ })).toBeVisible();

  const ocr = page.getByLabel(/Enable local OCR for scanned pages/);
  await ocr.check();
  await expect(page.locator('.results')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Export review CSV/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Compare documents/ })).toBeEnabled();

  await ocr.uncheck();
  await page.getByRole('button', { name: /Compare documents/ }).click();
  await expect(page.locator('.finding')).toHaveCount(1);

  const ai = page.getByLabel(/Suggest matches with local AI/);
  await ai.check();
  await expect(page.locator('.results')).toHaveCount(0);
  await ai.uncheck();
  await page.getByRole('button', { name: /Compare documents/ }).click();
  await expect(page.locator('.finding')).toHaveCount(1);
});

function reviewFixture(pages: string[][]): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${i * 2 + 4} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, lines] of pages.entries()) {
    const stream = lines.map((line, row) =>
      `BT /F1 12 Tf 40 ${754 - row * 23} Td (${line.replace(/[\\()]/g, '\\$&')}) Tj ET\n`
    ).join('');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${index * 2 + 5} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    );
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function compareReviewFixture(
  page: import('@playwright/test').Page, original: string[][], revised: string[][],
) {
  await page.goto('/');
  for (const [role, pages] of [['original', original], ['revised', revised]] as const) {
    await page.locator(`#${role}`).setInputFiles({
      name: `${role}-review.pdf`, mimeType: 'application/pdf', buffer: reviewFixture(pages),
    });
  }
  await page.getByRole('button', { name: /Compare documents/ }).click();
}

test('pages and filters a real comparison while exporting all findings and review selections', async ({ page }) => {
  function rows(day: number, amount: number) {
    return [
      ...Array.from({ length: 22 }, (_, i) => `Track code T${i} deadline: ${day} December 2026`),
      `Paper 1 fee: Rs. ${amount}`,
    ];
  }
  await compareReviewFixture(page, [rows(13, 200)], [rows(14, 300)]);
  const count = page.locator('.review-count');
  const cards = page.locator('.finding');
  await expect(cards).toHaveCount(20);
  await expect(count).toHaveText('Showing 1–20 of 23 matching findings (23 total)');
  await page.getByRole('button', { name: 'Next findings' }).click();
  await expect(cards).toHaveCount(3);
  await expect(count).toBeFocused();
  await expect(count).toHaveText('Showing 21–23 of 23 matching findings (23 total)');

  await page.getByLabel('Search source text').fill('  PAPER 1   FEE ');
  await page.getByLabel('Category').selectOption('fee');
  await page.getByLabel('Checklist status').selectOption('pending');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Paper 1 fee: Rs. 300');
  await cards.getByRole('checkbox').click();
  await expect(count).toBeFocused();
  await expect(count).toHaveText('No findings match these filters.');
  await page.getByLabel('Checklist status').selectOption('reviewed');
  await page.getByLabel('Finding status').selectOption('confirmed_change');
  await expect(cards.getByRole('checkbox')).toBeChecked();
  await expect(page.locator('.review-progress')).toContainText('1/23 marked reviewed');

  await page.getByRole('button', { name: 'हिंदी' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
  await expect(page.getByLabel('मूल पाठ खोजें')).toHaveValue('  PAPER 1   FEE ');
  await expect(cards.getByRole('checkbox')).toBeChecked();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: /प्रमाण रिपोर्ट डाउनलोड करें/ }).click();
  const payload = JSON.parse(await readFile(await (await downloadReady).path(), 'utf8'));
  expect(payload.findings).toHaveLength(23);
  expect(payload.review).toEqual([payload.findings.find((finding: { category: string }) =>
    finding.category === 'fee').id]);
  await page.getByRole('button', { name: 'फ़िल्टर हटाएँ' }).click();
  await expect(cards).toHaveCount(20);
});

test('opens an uncovered PDF page for manual review without a fabricated highlight', async ({ page }) => {
  await compareReviewFixture(
    page, [['Application deadline: 13 December 2026'], []],
    [['Application deadline: 14 December 2026']],
  );
  const coverage = page.locator('.coverage-report');
  await expect(coverage).toContainText('1/2 pages yielded text');
  await coverage.getByText('Open pages with no extracted text (1)').click();
  const open = coverage.getByRole('button', { name: 'Page 2' });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'original-review.pdf · Page 2' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('No text was extracted from this page. Inspect the page directly.')).toBeVisible();
  await expect(dialog.locator('canvas')).toBeVisible();
  await expect(dialog.locator('.evidence-highlight')).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: /Open PDF in new tab/ })).toHaveAttribute('href', /#page=2$/);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
});

test('discloses a fuzzy-search limit separately from page text coverage and exports it', async ({ page }) => {
  function denseNotice(code: string) {
    return [0, 1, 2].map(batch => Array.from({ length: 23 }, (_, i) =>
      `Track ${code}${batch * 23 + i} deadline: 13 December 2026`
    ));
  }
  await compareReviewFixture(page, denseNotice('Alpha'), denseNotice('Bravo'));
  await expect(page.getByText(/Every PDF page yielded some text/)).toBeVisible();
  await expect(page.getByText(/matching limit was reached/)).toBeVisible();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export review CSV/ }).click();
  const csv = await readFile(await (await downloadReady).path(), 'utf8');
  expect(csv.split('\r\n')[0]).toContain('"text_coverage","fuzzy_matching_limited"');
  expect(csv.split('\r\n')[1]).toMatch(/"all_pages_have_text","yes"$/);
});
