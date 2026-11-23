import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

function noticePdf(withImage: boolean): Buffer {
  const page = [
    withImage ? 'q 540 0 0 640 35 77 cm /Scan Do Q' : '',
    'BT /F1 14 Tf 45 752 Td (Riverton circular) Tj ET',
  ].join('\n') + '\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      `/Resources << /Font << /F1 4 0 R >> ${withImage ? '/XObject << /Scan 6 0 R >>' : ''} >> ` +
      '/Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(page)} >>\nstream\n${page}endstream`,
  ];
  if (withImage) {
    // The image is deliberately synthetic and contains no applicant information.
    const pixels = deflateSync(Buffer.alloc(256 * 256, 215)).toString('hex') + '>\n';
    objects.push('<< /Type /XObject /Subtype /Image /Width 256 /Height 256 ' +
      '/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter [/ASCIIHexDecode /FlateDecode] ' +
      `/Length ${Buffer.byteLength(pixels)} >>\nstream\n${pixels}endstream`);
  }
  let source = '%PDF-1.4\n';
  const offsets = ['0000000000 65535 f \n'];
  for (const [index, value] of objects.entries()) {
    offsets.push(`${String(Buffer.byteLength(source)).padStart(10, '0')} 00000 n \n`);
    source += `${index + 1} 0 obj\n${value}\nendobj\n`;
  }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${offsets.length}\n${offsets.join('')}` +
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}

test('opens image-heavy pages and points users to the right OCR settings', async ({ page }) => {
  await page.goto('/');
  for (const [role, withImage] of [['original', true], ['revised', false]] as const) {
    await page.locator(`#${role}`).setInputFiles({
      name: `${role}.pdf`, mimeType: 'application/pdf', buffer: noticePdf(withImage),
    });
  }
  await page.getByRole('button', { name: /Compare documents/ }).click();
  await expect(page.getByText(/No wording differences were identified/)).toBeVisible();
  const flagged = page.getByText('Review pages with large images (1)', { exact: true });
  await expect(flagged).toHaveCount(1);
  await flagged.click();
  await page.locator('.coverage-report').getByRole('button', { name: 'Page 1', exact: true }).click();
  const preview = page.getByRole('dialog');
  await expect(preview.getByRole('img', { name: 'Source PDF page 1' })).toBeVisible();
  await expect(preview.getByText(/Inspect the image on this page/)).toBeVisible();
  await expect(preview.locator('.evidence-highlight')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Open selected-page OCR settings' }).click();
  await expect(page.getByLabel('Original notice OCR pages')).toBeFocused();
  await expect(page.getByLabel('Original notice OCR pages')).toHaveValue('');
  await expect(page.getByLabel('Enable local OCR for scanned pages')).not.toBeChecked();

  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export evidence report/ }).click();
  const report = JSON.parse(await readFile(await (await downloadReady).path(), 'utf8'));
  expect(report.documents.map((document: { pages_with_unchecked_images: number[] }) =>
    document.pages_with_unchecked_images)).toEqual([[1], []]);
});
