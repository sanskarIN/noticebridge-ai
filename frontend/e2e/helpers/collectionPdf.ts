import { Buffer } from 'node:buffer';

/** Small real multi-page PDF fixtures, using only synthetic notice text. */
export function collectionPdf(pages: string[][]): Buffer {
  const escape = (text: string) => text.replace(/[\\()]/g, '\\$&');
  const fontId = 3 + pages.length * 2;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count ' + pages.length + ' /Kids [' +
      pages.map((_, i) => (3 + i * 2) + ' 0 R').join(' ') + '] >>',
  ];
  for (const [index, lines] of pages.entries()) {
    const pageId = 3 + index * 2;
    const stream = lines.map((line, i) => 'BT /F1 12 Tf 40 ' + (720 - i * 30) +
      ' Td (' + escape(line) + ') Tj ET\n').join('');
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ' +
      fontId + ' 0 R >> >> /Contents ' + (pageId + 1) + ' 0 R >>');
    objects.push('<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + 'endstream');
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(body));
    body += (i + 1) + ' 0 obj\n' + object + '\nendobj\n';
  });
  const xref = Buffer.byteLength(body);
  body += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (const offset of offsets) body += String(offset).padStart(10, '0') + ' 00000 n \n';
  body += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(body);
}
