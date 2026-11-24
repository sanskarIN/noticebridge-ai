import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import type { Report } from '../src/comparison';

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

test('exports source-bound evidence JSON from a live upload', async ({ page }) => {
  await addSources(page);
  await page.getByLabel('Enable local OCR for scanned pages').check();
  await page.getByRole('button', { name: /Compare documents/ }).click();
  await expect(page.locator('.finding')).toHaveCount(1);
  const promise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export evidence report/ }).click();
  const download = await promise;
  const payload = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(payload.documents).toHaveLength(2);
  expect(payload.automatic_ocr).toBe(true);
  expect(payload.documents.map((document: { ocr_pages: number[] }) => document.ocr_pages))
    .toEqual([[], []]);
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


function widePagePdf(day: number, baseline = 3900): Buffer {
  // Tiny fictional native-text PDF with a deliberately large page.
  const stream = `BT /F1 24 Tf 80 ${baseline} Td (Deadline: ${day} December 2026) Tj ET\n`;
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

test('reveals evidence low on a PDF page and bounds the high-resolution canvas', async ({ browser }) => {
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    baseURL: 'http://127.0.0.1:5173',
  });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await page.locator('#original').setInputFiles({
      name: 'wide-original.pdf', mimeType: 'application/pdf', buffer: widePagePdf(13, 140),
    });
    await page.locator('#revised').setInputFiles({
      name: 'wide-revised.pdf', mimeType: 'application/pdf', buffer: widePagePdf(14, 140),
    });
    await page.getByRole('button', { name: /Compare documents/ }).click();
    await expect(page.locator('.finding')).toHaveCount(1);
    await page.getByRole('button', { name: /Open PDF page/ }).first().click();
    const canvas = page.locator('.preview-dialog canvas');
    await expect(canvas).toBeVisible();
    await expect(page.locator('.evidence-highlight')).toBeInViewport({ ratio: 1 });
    const viewer = page.getByRole('region', { name: 'PDF page viewer' });
    await expect.poll(() => viewer.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
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
  const viewer = dialog.getByRole('region', { name: 'PDF page viewer' });
  await expect(viewer.locator('.evidence-highlight')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(viewer).toBeFocused();
  await page.keyboard.press('PageDown');
  await expect.poll(() => viewer.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('link', { name: /Open PDF in new tab/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(launch).toBeFocused();
  await expect(page.locator('main')).not.toHaveAttribute('inert');
});

test('compares both exact source pages and releases their browser URLs', async ({ page }) => {
  await compareReviewFixture(
    page, [['Application deadline: 13 December 2026', 'Candidates must bring identification']],
    [['Riverton circular'], ['Application deadline: 11 December 2026']],
  );
  const finding = page.locator('.finding').filter({ hasText: '11 December 2026' });
  const launch = finding.getByRole('button', { name: 'Compare source pages' });
  await expect(page.locator('.finding').filter({ hasText: 'Candidates must bring identification' })
    .getByRole('button', { name: 'Compare source pages' })).toHaveCount(0);
  await launch.click();
  const dialog = page.getByRole('dialog', { name: 'Compare source pages' });
  const original = dialog.getByRole('region', { name: /Original notice.*Page 1/ });
  const updated = dialog.getByRole('region', { name: /Updated notice.*Page 2/ });
  const close = dialog.getByRole('button', { name: /Close preview/ });
  await expect(close).toBeFocused();
  for (const [pane, day] of [[original, 13], [updated, 11]] as const) {
    await expect(pane.locator('.evidence-highlight')).toBeVisible();
    await expect(pane.locator('.preview-quote')).toHaveText(`Application deadline: ${day} December 2026`);
  }
  const first = await original.boundingBox();
  const second = await updated.boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(second!.x).toBeGreaterThanOrEqual(first!.x + first!.width);
  const newTabs = dialog.getByRole('link', { name: /Open PDF in new tab/ });
  await expect(newTabs).toHaveCount(2);
  await expect(newTabs.first()).toHaveAttribute('href', /^blob:.*#page=1$/);
  await expect(newTabs.last()).toHaveAttribute('href', /^blob:.*#page=2$/);
  const urls = await newTabs.evaluateAll(links => links.map(link => (link as HTMLAnchorElement).href));
  const blobAvailability = () => page.evaluate(async values =>
    Promise.all(values.map(url => fetch(url).then(response => response.ok, () => false))), urls);
  expect(await blobAvailability()).toEqual([true, true]);

  await page.keyboard.press('Shift+Tab');
  await expect(newTabs.last()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(launch).toBeFocused();
  await expect.poll(blobAvailability).toEqual([false, false]);
});

test('stacks both highlighted PDF pages on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await addSources(page);
  await page.getByRole('button', { name: /Compare documents/ }).click();
  await page.getByRole('button', { name: 'Compare source pages' }).click();
  const dialog = page.getByRole('dialog', { name: 'Compare source pages' });
  const panes = dialog.locator('.preview-source');
  await expect(panes).toHaveCount(2);
  await expect(dialog.locator('.evidence-highlight')).toHaveCount(2);
  const original = await panes.first().boundingBox();
  const updated = await panes.last().boundingBox();
  expect(original!.x).toBeCloseTo(updated!.x, 1);
  expect(updated!.y).toBeGreaterThanOrEqual(original!.y + original!.height);
  expect(await dialog.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(320);
  await panes.last().getByRole('link').scrollIntoViewIfNeeded();
  await expect(panes.last().getByRole('link')).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
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


test('labels the exact changed date within both full source quotes', async ({ page }) => {
  await addSources(page);
  await page.getByRole('button', { name: /Compare documents/ }).click();
  const finding = page.locator('.finding');
  await expect(finding.locator('.category')).toHaveText('Deadline');
  await expect(finding.locator('.value-outcome')).toHaveText('Date: Changed');
  await expect(finding.locator('blockquote').first()).toHaveText('Application deadline: 13 December 2026');
  await expect(finding.locator('mark')).toHaveText(['13 December 2026', '14 December 2026']);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('highlights ordinal and hyphenated dates while keeping date ranges uncertain', async ({ page }) => {
  await compareReviewFixture(page, [[
    'Application deadline: 19th-Dec-2026',
    'Interview booking deadline: 13th to 15th December 2026',
  ]], [[
    'Application deadline: December 13th, 2026',
    'Interview booking deadline: 13th to 14th December 2026',
  ]]);
  const priority = page.getByRole('region', { name: 'Review first' });
  await expect(priority.locator('strong')).toHaveText([
    'Deadline moved 6 days earlier', 'Deadline needs verification',
  ]);
  await priority.getByRole('button', { name: /Inspect finding: Deadline moved/ }).click();
  const deadline = page.locator('#finding-f1');
  await expect(deadline.locator('mark')).toHaveText(['19th-Dec-2026', 'December 13th, 2026']);
  await deadline.getByRole('button', { name: /Open PDF page/ }).last().click();
  await expect(page.locator('.preview-quote')).toHaveText('Application deadline: December 13th, 2026');
  await expect(page.locator('.evidence-highlight')).toBeVisible();
  await page.keyboard.press('Escape');

  const range = page.locator('#finding-f2');
  await expect(range.locator('.value-outcome')).toHaveText('Date: Uncertain');
  await expect(range.locator('mark')).toHaveCount(0);
  await expect(range.locator('blockquote').last())
    .toHaveText('Interview booking deadline: 13th to 14th December 2026');
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

test('review CSV is downloadable without a mobile horizontal overflow', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    baseURL: 'http://127.0.0.1:5173',
  });
  try {
    const page = await context.newPage();
    await addSources(page);
    await page.getByRole('button', { name: /Compare documents/ }).click();
    const downloadReady = page.waitForEvent('download');
    await page.getByRole('button', { name: /Export review CSV/ }).click();
    const csv = await readFile(await (await downloadReady).path(), 'utf8');
    expect(csv).toContain('Application deadline: 14 December 2026');
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

type ReviewFixtureLine = string | readonly [label: string, value: string];

function reviewFixture(pages: ReviewFixtureLine[][]): Buffer {
  const textAt = (text: string, x: number, y: number) =>
    `BT /F1 12 Tf ${x} ${y} Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${i * 2 + 4} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, lines] of pages.entries()) {
    const stream = lines.map((line, row) => {
      const y = 754 - row * 23;
      if (typeof line === 'string') return textAt(line, 40, y);
      const [label, value] = line;
      return `32 ${y - 6} 218 23 re S\n250 ${y - 6} 280 23 re S\n` +
        textAt(label, 40, y) + textAt(value, 260, y);
    }).join('');
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
  page: import('@playwright/test').Page,
  original: ReviewFixtureLine[][], revised: ReviewFixtureLine[][],
) {
  await page.goto('/');
  for (const [role, pages] of [['original', original], ['revised', revised]] as const) {
    await page.locator(`#${role}`).setInputFiles({
      name: `${role}-review.pdf`, mimeType: 'application/pdf', buffer: reviewFixture(pages),
    });
  }
  await page.getByRole('button', { name: /Compare documents/ }).click();
}

test('keeps ruled deadline and fee cells together through review and export', async ({ page }) => {
  await compareReviewFixture(page, [[
    ['Requirement', 'Published value'],
    ['Application deadline', '13 December 2026'],
    ['Application fee', 'Rs. 300'],
  ]], [[
    ['Requirement', 'Published value'],
    ['Application fee', 'Rs. 450'],
    ['Application deadline', '11 December 2026'],
  ]]);

  const priorities = page.getByRole('region', { name: 'Review first' });
  await expect(priorities.locator('strong')).toHaveText([
    'Deadline moved 2 days earlier', 'Fee changed',
  ]);
  await priorities.getByRole('button', { name: /Inspect finding: Deadline moved/ }).click();
  const deadline = page.locator('#finding-f1');
  await expect(deadline.locator('blockquote')).toHaveText([
    'Application deadline 13 December 2026', 'Application deadline 11 December 2026',
  ]);
  await expect(deadline.locator('mark')).toHaveText(['13 December 2026', '11 December 2026']);
  await deadline.getByRole('button', { name: /Open PDF page/ }).last().click();
  await expect(page.locator('.preview-quote')).toHaveText('Application deadline 11 December 2026');
  const highlight = page.locator('.evidence-highlight');
  await expect(highlight).toBeVisible();
  expect(await highlight.evaluate(element => parseFloat(element.style.width))).toBeGreaterThan(40);
  await page.keyboard.press('Escape');

  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export evidence report/ }).click();
  const report = JSON.parse(await readFile(await (await downloadReady).path(), 'utf8'));
  expect(report.findings).toHaveLength(2);
  expect(report.findings[1]).toMatchObject({
    category: 'fee',
    original: { page: 1, text: 'Application fee Rs. 300' },
    revised: { page: 1, text: 'Application fee Rs. 450' },
    field_changes: [{ outcome: 'changed', revised: { canonical: 'INR 450.00' } }],
  });
});

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

  await expect(page.getByLabel('Search source text')).toHaveValue('  PAPER 1   FEE ');
  await expect(cards.getByRole('checkbox')).toBeChecked();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export evidence report/ }).click();
  const payload = JSON.parse(await readFile(await (await downloadReady).path(), 'utf8'));
  expect(payload.findings).toHaveLength(23);
  expect(payload.review).toEqual([payload.findings.find((finding: { category: string }) =>
    finding.category === 'fee').id]);
  await page.getByRole('button', { name: 'Clear filters' }).click();
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

test('retries selected OCR pages explicitly and preserves the previous report after failure', async ({ page }) => {
  let requests = 0;
  const postBodies: string[] = [];
  await page.route('**/api/compare', async route => {
    requests += 1;
    postBodies.push(route.request().postDataBuffer()?.toString() ?? '');
    if (requests === 2) {
      await route.fulfill({ status: 503, json: { detail: 'Temporary processing failure' } });
    } else {
      await route.continue();
    }
  });
  await compareReviewFixture(page, [['Application deadline: 13 December 2026'], []], [
    ['Application deadline: 14 December 2026'], [],
  ]);
  const deadline = page.getByRole('checkbox', { name: /Verify the deadline/ });
  await deadline.check();
  const coverage = page.getByRole('region', { name: 'Text extraction coverage' });
  for (const group of await coverage.getByText('Open pages with no extracted text (1)').all()) {
    await group.click();
  }
  const original = coverage.getByRole('checkbox', { name: 'Select original notice page 2 for OCR' });
  const revised = coverage.getByRole('checkbox', { name: 'Select updated notice page 2 for OCR' });
  await original.check();
  await revised.check();
  await expect(coverage.getByText(/Both PDFs are uploaded again/)).toBeVisible();
  expect(requests).toBe(1);
  const rerun = coverage.getByRole('button', { name: 'Compare again with OCR on 2 more pages' });
  await rerun.click();
  await expect(coverage.getByRole('alert')).toContainText('Temporary processing failure');
  await expect(deadline).toBeChecked();
  await expect(original).toBeChecked();
  await expect(revised).toBeChecked();
  await expect(page.getByRole('button', { name: /Export evidence report/ })).toBeVisible();
  await expect(page.getByLabel('Original notice OCR pages')).toHaveValue('');

  await rerun.click();
  await expect(coverage.getByText('Selected for OCR · 2', { exact: true })).toHaveCount(2);
  await expect(coverage.getByRole('alert')).toHaveCount(0);
  await expect(deadline).toBeChecked();
  await expect(page.getByLabel('Original notice OCR pages')).toHaveValue('2');
  await expect(page.getByLabel('Updated notice OCR pages')).toHaveValue('2');
  expect(requests).toBe(3);
  for (const option of ['original_ocr_pages', 'revised_ocr_pages']) {
    expect(postBodies[2]).toContain(`name="${option}"\r\n\r\n2\r\n`);
  }
  expect(postBodies[2]).toContain('name="enable_ocr"\r\n\r\nfalse\r\n');
  expect(postBodies[2]).toContain('name="enable_semantic"\r\n\r\nfalse\r\n');
});

test('counts previous OCR choices against the page limit and preserves them in the rerun', async ({ page }) => {
  const pages = [['Application deadline: 13 December 2026'], ...Array.from({ length: 13 }, () => [])];
  await page.goto('/');
  for (const [role, buffer] of [['original', reviewFixture(pages)], ['revised', revisedPdf]] as const) {
    await page.locator(`#${role}`).setInputFiles({ name: `${role}.pdf`, mimeType: 'application/pdf', buffer });
  }
  await page.getByText('Recover text on selected pages with OCR', { exact: true }).click();
  await page.getByLabel('Original notice OCR pages').fill('2–12');
  await page.getByRole('button', { name: /Compare documents/ }).click();
  const coverage = page.getByRole('region', { name: 'Text extraction coverage' });
  await expect(coverage.getByText('11/12 selected OCR pages for this PDF')).toBeVisible();
  await coverage.getByText(/Open pages with no extracted text/).click();
  const page13 = coverage.getByRole('checkbox', { name: 'Select original notice page 13 for OCR' });
  const page14 = coverage.getByRole('checkbox', { name: 'Select original notice page 14 for OCR' });
  await expect(coverage.getByRole('checkbox', { name: 'Select original notice page 2 for OCR' })).toHaveCount(0);
  await page13.check();
  await expect(page14).toBeDisabled();
  await page13.uncheck();
  await page14.check();
  await expect(page13).toBeDisabled();
  await coverage.getByRole('button', { name: 'Compare again with OCR on 1 more page' }).click();
  await expect(coverage.getByText('12/12 selected OCR pages for this PDF')).toBeVisible();
  await expect(page.getByLabel('Original notice OCR pages')).toHaveValue('2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14');
});

test('a successful OCR retry clears review marks for changed evidence at the same finding ID', async ({ page }) => {
  await compareReviewFixture(page, [[
    'Application deadline: 13 December 2026', 'Application fee: Rs. 200',
  ], []], [[
    'Application deadline: 14 December 2026', 'Application fee: Rs. 300',
  ]]);
  const deadline = page.getByRole('checkbox', { name: /Verify the deadline/ });
  const fee = page.getByRole('checkbox', { name: /Verify the fee/ });
  await deadline.check();
  await fee.check();
  await page.route('**/api/compare', async route => {
    const response = await route.fetch();
    const report: Report = await response.json();
    // Exercise the UI's stale-review guard even if Tesseract is unavailable in this browser job.
    const finding = report.findings.find(item => item.category === 'fee');
    if (!finding?.original) throw new Error('Expected the fictional fee evidence');
    finding.original.text += ' (different extraction)';
    await route.fulfill({ response, json: report });
  }, { times: 1 });

  const coverage = page.getByRole('region', { name: 'Text extraction coverage' });
  await coverage.getByText(/Open pages with no extracted text/).click();
  await coverage.getByRole('checkbox', { name: 'Select original notice page 2 for OCR' }).check();
  await coverage.getByRole('button', { name: 'Compare again with OCR on 1 more page' }).click();
  await expect(coverage.getByText('Selected for OCR · 2', { exact: true })).toBeVisible();
  await expect(deadline).toBeChecked();
  await expect(fee).not.toBeChecked();
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

test('restores a local checklist after reload and checks both fingerprints and evidence', async ({ page }) => {
  await addSources(page);
  await page.getByRole('button', { name: /Compare documents/ }).click();
  const checkbox = page.locator('.checklist-item input');
  await checkbox.check();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export evidence report/ }).click();
  const original = await readFile(await (await downloadReady).path());

  // Re-run the comparison after reload. File bytes stay identical even
  // when a user has renamed the source PDFs since exporting the report.
  await page.reload();
  for (const [id, buffer] of [['original', originalPdf], ['revised', revisedPdf]] as const) {
    await page.locator(`#${id}`).setInputFiles({
      name: `${id}-renamed.pdf`, mimeType: 'application/pdf', buffer,
    });
  }
  await page.getByRole('button', { name: /Compare documents/ }).click();
  await expect(checkbox).not.toBeChecked();
  const input = page.locator('.review-restore input');
  let apiRequests = 0;
  page.on('request', request => { if (request.url().includes('/api/')) apiRequests += 1; });

  const imported = JSON.parse(original.toString('utf8'));
  imported.findings[0].original.text = 'Different text on the same PDF page';
  await input.setInputFiles({
    name: 'changed-evidence.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await expect(page.getByText(/produced different findings/)).toBeVisible();
  await expect(checkbox).not.toBeChecked();

  await input.setInputFiles({
    name: 'noticebridge-evidence-report.json', mimeType: 'application/json', buffer: original,
  });
  await expect(page.getByText('Loaded 1 saved checklist selection.')).toBeVisible();
  await expect(checkbox).toBeChecked();

  const mismatched = JSON.parse(original.toString('utf8'));
  mismatched.documents.reverse();
  await input.setInputFiles({
    name: 'reversed-sources.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(mismatched)),
  });
  await expect(page.getByText(/different PDF pair or upload order/)).toBeVisible();
  await expect(checkbox).toBeChecked();
  expect(apiRequests).toBe(0);
});

test('a saved checklist adds to current selections and stays bound to the active comparison', async ({ page }) => {
  const old = [['Application deadline: 13 December 2026', 'Application fee: Rs. 200']];
  const updated = [['Application deadline: 14 December 2026', 'Application fee: Rs. 300']];
  await compareReviewFixture(page, old, updated);
  const deadline = page.getByRole('checkbox', { name: /Verify the deadline/ });
  const fee = page.getByRole('checkbox', { name: /Verify the fee/ });
  await deadline.check();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export evidence report/ }).click();
  const buffer = await readFile(await (await downloadReady).path());
  await deadline.uncheck();
  await fee.check();

  const input = page.locator('.review-restore input');
  await input.setInputFiles({ name: 'review.json', mimeType: 'application/json', buffer });
  await expect(page.getByText('Loaded 1 saved checklist selection.')).toBeVisible();
  await expect(deadline).toBeChecked();
  await expect(fee).toBeChecked();

  // Pause the local read, replace the active report, then finish the read.
  // The old import must be unable to select items on the newly mounted report.
  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = function () {
      if (this.name !== 'delayed-review.json') return original.call(this);
      const file = this;
      return new Promise<string>(resolve => {
        document.addEventListener('finish-test-import', () => {
          void original.call(file).then(text => {
            resolve(text);
            document.dispatchEvent(new Event('test-import-read-finished'));
          });
        }, { once: true });
      });
    };
  });
  await input.setInputFiles({ name: 'delayed-review.json', mimeType: 'application/json', buffer });
  await expect(page.getByRole('button', { name: 'Checking saved report…' })).toBeDisabled();
  await page.getByLabel(/Enable local OCR for scanned pages/).check();
  await expect(page.locator('.results')).toHaveCount(0);
  await page.getByRole('button', { name: /Compare documents/ }).click();
  await expect(deadline).not.toBeChecked();
  await page.evaluate(() => new Promise<void>(resolve => {
    document.addEventListener('test-import-read-finished', () => {
      requestAnimationFrame(() => resolve());
    }, { once: true });
    document.dispatchEvent(new Event('finish-test-import'));
  }));
  await expect(deadline).not.toBeChecked();
  await expect(fee).not.toBeChecked();
});

test('page-specific OCR reports a coverage gap when a selected page exceeds the render budget', async ({
  page,
}) => {
  await addSources(page);
  const original = page.locator('#original');
  await original.setInputFiles({
    name: 'wide-original.pdf', mimeType: 'application/pdf', buffer: widePagePdf(13),
  });
  await page.getByText('Recover text on selected pages with OCR', { exact: true }).click();
  const pages = page.getByLabel('Original notice OCR pages');
  const compare = page.getByRole('button', { name: /Compare documents/ });
  await pages.fill('2');
  await compare.click();
  await expect(page.getByRole('alert')).toContainText('outside the original PDF');

  await pages.fill('१');
  await compare.click();
  const coverage = page.locator('.coverage-report');
  await expect(coverage).toContainText('Selected for OCR · 1');
  await expect(coverage).toContainText('0/1 pages yielded text');
  await expect(page.getByText(/page would exceed OCR pixel limit/)).toBeVisible();
  await expect(page.locator('.finding')).toHaveCount(1);
  await expect(page.locator('.finding')).not.toContainText('Deadline: 13 December 2026');
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export evidence report/ }).click();
  const report = JSON.parse(await readFile(await (await downloadReady).path(), 'utf8'));
  expect(report.automatic_ocr).toBe(false);
  expect(report.documents[0].ocr_override_pages).toEqual([1]);
  await page.getByLabel('Original notice OCR pages').fill('');
  await expect(page.locator('.results')).toHaveCount(0);
});

test('runs the fictional demo through the live API and prioritizes the earlier deadline', async ({ page }) => {
  await page.goto('/');
  const responseReady = page.waitForResponse(response =>
    response.url().endsWith('/api/compare') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Try a fictional notice' }).click();
  const response = await responseReady;
  expect(response.ok()).toBe(true);
  const data = await response.json();
  expect(data.findings).toHaveLength(3);
  await expect(page.getByText('Live comparison · Fictional notices')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Findings', exact: true })).toBeFocused();

  const first = page.getByRole('region', { name: 'Review first' });
  await expect(first.locator('strong')).toHaveText([
    'Deadline moved 6 days earlier', 'Deadline needs verification', 'Fee changed',
  ]);
  await page.getByLabel('Category').selectOption('fee');
  await expect(page.locator('.finding')).toHaveCount(1);
  await first.getByRole('button', { name: /Inspect finding: Deadline moved/ }).click();
  const deadline = page.locator('#finding-f1');
  await expect(deadline).toBeFocused();
  await expect(page.getByLabel('Category')).toHaveValue('all');
  await expect(deadline.locator('mark')).toHaveText(['19 December 2026', '13 December 2026']);
  await deadline.getByRole('button', { name: /Open PDF page/ }).last().click();
  await expect(page.locator('.evidence-highlight')).toBeVisible();
  await page.keyboard.press('Escape');

  await deadline.getByRole('checkbox').check();
  await expect(first.getByText('Deadline moved 6 days earlier')).toHaveCount(0);
  const ambiguous = page.locator('#finding-f3');
  await expect(ambiguous.locator('.value-outcome')).toHaveText('Date: Uncertain');
  await expect(ambiguous.locator('mark')).toHaveCount(0);
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export evidence report/ }).click();
  const result = JSON.parse(await readFile(await (await downloadReady).path(), 'utf8'));
  expect(result.comparison_source).toBe('live_demo');
  expect(result.review).toEqual(['f1']);
});

test('prioritizes same-date cutoff changes and displays their quoted times', async ({ page }) => {
  await compareReviewFixture(page, [[
    'Application deadline: 13 December 2026 at 5:00 PM IST',
    'Reporting time: 08:00 IST',
    'Interview time: 9:30',
  ]], [[
    'Application deadline: 13 December 2026 at 14:00 IST',
    'Reporting time: 07:30 IST',
    'Interview time: 10:30 AM',
  ]]);

  const first = page.getByRole('region', { name: 'Review first' });
  await expect(first.locator('strong')).toHaveText([
    'Deadline time changed', 'Scheduled time changed', 'Scheduled time needs verification',
  ]);
  await first.getByRole('button', { name: 'Inspect finding: Deadline time changed' }).click();
  const deadline = page.locator('#finding-f1');
  await expect(deadline).toBeFocused();
  await expect(deadline.locator('.value-outcome')).toHaveText(['Date: Same value', 'Time: Changed']);
  await expect(deadline.locator('mark')).toHaveText(['5:00 PM', '14:00']);
  await deadline.getByRole('button', { name: /Open PDF page/ }).last().click();
  await expect(page.locator('.evidence-highlight')).toBeVisible();
  await page.keyboard.press('Escape');

  const interview = page.locator('#finding-f3');
  await expect(interview.locator('.value-outcome')).toHaveText('Time: Uncertain');
  await expect(interview.locator('mark')).toHaveCount(0);
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export evidence report/ }).click();
  const report = JSON.parse(await readFile(await (await downloadReady).path(), 'utf8'));
  expect(report.findings[0].field_changes[1]).toMatchObject({
    kind: 'time', outcome: 'changed',
    original: { raw: '5:00 PM', canonical: '17:00' },
    revised: { raw: '14:00', canonical: '14:00' },
  });
  expect(report.findings[0].authority_verified).toBe(false);
});

test('shows both cutoff values when the revision crosses midnight', async ({ page }) => {
  await compareReviewFixture(
    page, [['Application deadline: 13 December 2026 at 23:59 IST']],
    [['Application deadline: 14 December 2026 at 00:01 IST']],
  );
  const first = page.getByRole('region', { name: 'Review first' });
  await expect(first.locator('strong')).toHaveText('Deadline date and time changed');
  await expect(first).toContainText('13 December 2026 at 23:59 → 14 December 2026 at 00:01');
  await expect(page.locator('.finding mark')).toHaveText([
    '13 December 2026', '23:59', '14 December 2026', '00:01',
  ]);
});

test('links a separate amendment to the quoted original without accepting its authority', async ({ page }) => {
  await compareReviewFixture(
    page, [['Application deadline: 19 December 2026', 'Application fee: Rs. 500']],
    [['Application deadline revised from December 19, 2026 to Dec. 13, 2026',
      'Application fee was reduced from Rs. 500 to Rs. 350']],
  );
  const findings = page.locator('.finding');
  await expect(findings).toHaveCount(2);
  const finding = findings.first();
  await expect(finding.locator('.match-score')).toHaveText('Explicit amendment wording');
  await expect(finding.locator('.status')).toHaveText('Possible change');
  await expect(finding.locator('.value-outcome')).toHaveText('Date: Stated in amendment');
  await expect(finding.locator('blockquote')).toHaveText([
    'Application deadline: 19 December 2026',
    'Application deadline revised from December 19, 2026 to Dec. 13, 2026',
  ]);
  await expect(page.getByRole('button', {
    name: 'Inspect finding: Deadline amendment needs verification',
  })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect finding: Fee amendment needs verification' }).click();
  await expect(findings.last()).toBeFocused();
  await expect(findings.last().locator('.value-outcome')).toHaveText('Amount: Stated in amendment');
  await finding.getByRole('button', { name: /Open PDF page/ }).last().click();
  await expect(page.locator('.evidence-highlight')).toBeVisible();
});


test('Review first promotes unmatched deadlines without implying a revoked deadline', async ({
  page,
}) => {
  await compareReviewFixture(
    page,
    [['Application deadline: 13 December 2026', 'Application fee: Rs. 200']],
    [['Eligibility requirement: diploma', 'Application fee: Rs. 300']],
  );
  const first = page.getByRole('region', { name: 'Review first' });
  await expect(first.locator('strong')).toHaveText([
    'Unmatched deadline statement', 'Fee changed', 'Unmatched eligibility statement',
  ]);
  await expect(first).toContainText('Do not assume it was added or withdrawn');
  await first.getByRole('button', { name: 'Inspect finding: Unmatched deadline statement' }).click();
  const finding = page.locator('.finding').filter({ hasText: 'Application deadline: 13 December 2026' });
  await expect(finding).toBeFocused();
  await expect(finding.locator('.status')).toHaveText('Unmatched statement');
  await finding.getByRole('checkbox').check();
  await expect(first.getByText('Unmatched deadline statement')).toHaveCount(0);
});

test('Review first includes uncertain deadline wording without a parsed field delta', async ({
  page,
}) => {
  // The route controls the UI fixture, not the source extraction algorithm.
  await page.route('**/api/compare', async route => {
    const response = await route.fetch();
    const report = await response.json();
    const finding = report.findings[0];
    finding.status = 'possible_change';
    finding.field_changes = [];
    finding.original.extraction_method = 'ocr';
    await route.fulfill({ response, json: report });
  });
  await addSources(page);
  await page.getByRole('button', { name: /Compare documents/ }).click();
  const first = page.getByRole('region', { name: 'Review first' });
  await expect(first.locator('strong')).toHaveText(['Possible deadline wording change']);
  await expect(first).toContainText('without a reliably parsed date');
  await expect(first).toContainText('OCR transcription must be checked');
  await first.getByRole('button', { name: /Inspect finding: Possible deadline wording change/ }).click();
  await expect(page.locator('.finding')).toBeFocused();
});

test('Review first never silently treats an uncertain fee relationship as confirmed', async ({
  page,
}) => {
  await page.route('**/api/compare', async route => {
    const response = await route.fetch();
    const report = await response.json();
    const finding = report.findings[0];
    finding.category = 'fee';
    finding.status = 'possible_change';
    finding.field_changes = [];
    await route.fulfill({ response, json: report });
  });
  await addSources(page);
  await page.getByRole('button', { name: /Compare documents/ }).click();
  const first = page.getByRole('region', { name: 'Review first' });
  await expect(first.locator('strong')).toHaveText(['Possible fee wording change']);
  await expect(first).not.toContainText('Fee changed');
  await expect(first).toContainText('verify the intended requirement with the issuer');
});


test('Review first discloses hidden priority items and updates counts when reviewed', async ({
  page,
}) => {
  await compareReviewFixture(
    page,
    [[
      'Track A deadline: 13 December 2026',
      'Track B deadline: 13 December 2026',
      'Track C deadline: 13 December 2026',
      'Track D deadline: 13 December 2026',
    ]],
    [['Eligibility requirement: diploma']],
  );
  const first = page.getByRole('region', { name: 'Review first' });
  await expect(first.locator('li')).toHaveCount(3);
  await expect(first).toContainText('Showing 3 of 5 prioritized items.');
  await expect(first).toContainText('Review all findings below; this is not an official verification.');
  await first.getByRole('button', { name: /Inspect finding: Unmatched deadline statement/ }).first().click();
  await expect(page.locator('.finding').first()).toBeFocused();
  await page.locator('.finding').first().getByRole('checkbox').check();
  await expect(first).toContainText('Showing 3 of 4 prioritized items.');
  await expect(page.locator('.finding')).toHaveCount(5);
});


test('reviews and exports a scheduled-time amendment without claiming verification', async ({ page }) => {
  await compareReviewFixture(page, [
    ['Reporting time Shift 1: 17:00 IST'],
  ], [
    ['Reporting time Shift 1 hereby revised from 5 PM IST to 18:30 IST'],
  ]);
  const first = page.getByRole('region', { name: 'Review first' });
  const button = first.getByRole('button', {
    name: 'Inspect finding: Scheduled time amendment needs verification',
  });
  await expect(button).toBeVisible();
  await expect(first).toContainText('17:00 → 18:30');
  await expect(first).toContainText('time zone and applicability');
  await button.click();
  const finding = page.locator('.finding');
  await expect(finding).toHaveCount(1);
  await expect(finding).toBeFocused();
  await expect(finding.locator('.status')).toHaveText('Possible change');
  await expect(finding.locator('.match-score')).toHaveText('Explicit amendment wording');
  await expect(finding.locator('.value-outcome')).toHaveText('Time: Stated in amendment');
  await expect(finding.locator('mark')).toHaveCount(0);
  await finding.getByRole('button', { name: 'Compare source pages' }).click();
  await expect(page.locator('.evidence-highlight')).toHaveCount(2);
  await page.keyboard.press('Escape');
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export evidence report/ }).click();
  const report = JSON.parse(await readFile(await (await downloadReady).path(), 'utf8'));
  expect(report.findings[0]).toMatchObject({
    category: 'time', status: 'possible_change', authority_verified: false,
    match_method: 'explicit_amendment',
    field_changes: [{
      kind: 'time', outcome: 'uncertain',
      original: { raw: '17:00', canonical: '17:00' },
      revised: { raw: '18:30', canonical: '18:30' },
    }],
  });
});

test('retains date and cutoff time together in ruled table source quotes', async ({ page }) => {
  await compareReviewFixture(page, [[
    ['Requirement', 'Published value'],
    ['Application deadline', '13 December 2026 at 17:00 IST'],
    ['Reporting time', '18:00 IST'],
  ]], [[
    ['Requirement', 'Published value'],
    ['Reporting time', '18:00 IST'],
    ['Application deadline', '14 December 2026 at 16:00 IST'],
  ]]);
  const first = page.getByRole('region', { name: 'Review first' });
  await expect(first.locator('strong')).toHaveText('Deadline date and time changed');
  const finding = page.locator('.finding');
  await expect(finding).toHaveCount(1);
  await expect(finding.locator('.value-outcome')).toHaveText(['Date: Changed', 'Time: Changed']);
  await expect(finding.locator('blockquote')).toHaveText([
    'Application deadline 13 December 2026 at 17:00 IST',
    'Application deadline 14 December 2026 at 16:00 IST',
  ]);
  await expect(finding.locator('mark')).toHaveText([
    '13 December 2026', '17:00', '14 December 2026', '16:00',
  ]);
  await finding.getByRole('button', { name: 'Compare source pages' }).click();
  await expect(page.locator('.evidence-highlight')).toHaveCount(2);
});


test('revision table warnings surface review-only source-page actions', async ({ page }) => {
  // Exercise UI using allowlisted warnings independently of backend PDF geometry.
  await page.route('**/api/compare', async route => {
    const response = await route.fetch();
    const report = await response.json();
    const message = 'original: page 1 contains an earlier/revised date-and-time table; ' +
      'both printed values are retained, verify the column headings';
    report.warnings.push(
      message, message,
      'revised: page 1 contains an earlier/revised fee table; ' +
        'both printed values are retained, verify the column headings',
      'original: page 99 contains an earlier/revised date table; ' +
        'both printed values are retained, verify the column headings',
      'Unrecognized earlier/revised table claim',
    );
    await route.fulfill({ response, json: report });
  });
  await addSources(page);
  await page.getByRole('button', { name: /Compare documents/ }).click();
  const panel = page.getByRole('region', { name: 'Revision tables need source review' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/not confirmed amendments/i)).toBeVisible();
  await expect(panel.getByRole('button', { name: /Open original notice page 1/ })).toHaveCount(1);
  await expect(panel.getByRole('button', { name: /Open revised notice page 1/ })).toHaveCount(1);
  await expect(panel.getByRole('button')).toHaveCount(2);
  await panel.getByRole('button', { name: /Open original notice page 1/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('.evidence-highlight')).toHaveCount(0);
  await expect(page.getByRole('dialog').getByText('original.pdf · Page 1')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});


test('revision table review panel stays inside the mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route('**/api/compare', async route => {
    const response = await route.fetch();
    const report = await response.json();
    report.warnings.push(
      'revised: page 1 contains an earlier/revised date-and-time table; ' +
        'both printed values are retained, verify the column headings',
    );
    await route.fulfill({ response, json: report });
  });
  await addSources(page);
  await page.getByRole('button', { name: /Compare documents/ }).click();
  const panel = page.getByRole('region', { name: 'Revision tables need source review' });
  await expect(panel).toBeVisible();
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await panel.getByRole('button', { name: /Open revised notice page 1/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
});
