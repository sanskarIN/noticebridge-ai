import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const original = 'a'.repeat(64);
const revised = 'b'.repeat(64);
const source = { original, revised };
const counts = {
  confirmed_change: 1, possible_change: 0, contradiction: 0, missing_information: 0,
};

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function file(name: string, buffer: Buffer) {
  return { name, buffer, mimeType: 'application/json' };
}

function evidence(role: 'original' | 'revised', text: string, page = 1) {
  return { document_id: role, extraction_method: 'native', text, page };
}

function report() {
  return {
    automatic_ocr: false,
    semantic_assistance: 'not_requested',
    text_coverage: 'all_pages_have_text',
    documents: [
      { id: 'original', sha256: original, ocr_page_count: 0, ocr_pages: [], ocr_override_pages: [] },
      { id: 'revised', sha256: revised, ocr_page_count: 0, ocr_pages: [], ocr_override_pages: [] },
    ],
    findings: [{
      id: 'f1', status: 'confirmed_change', category: 'deadline', authority_verified: false,
      match_method: 'deterministic',
      original: evidence('original', 'Fictional deadline: 13 December'),
      revised: evidence('revised', 'Fictional deadline: 19 December'),
      supporting_evidence: [] as ReturnType<typeof evidence>[],
    }],
    checklist: [{ finding_id: 'f1', requires_human_verification: true }],
    warnings: [] as string[],
  };
}

function fixture(options: { partial?: boolean; saved?: object } = {}) {
  const body = json(options.saved ?? report());
  const pairs = [{
    original: 'private-original.pdf', revised: 'private-revised.pdf',
    original_sha256: original, revised_sha256: revised,
  }];
  if (options.partial) pairs.push({
    original: 'another-original.pdf', revised: 'another-revised.pdf',
    original_sha256: 'c'.repeat(64), revised_sha256: 'd'.repeat(64),
  });
  const manifest = json({ version: 1, cases: pairs });
  const index = {
    format: 'noticebridge-batch-index', version: 1, manifest_sha256: hash(manifest),
    case_count: pairs.length, completed_count: 1, complete: pairs.length === 1,
    authority_verified: false, status_counts: { ...counts },
    cases: [{
      case: 1, report: 'case-001.json', format: 'noticebridge-local-comparison-summary',
      source_fingerprints: { ...source }, status_counts: { ...counts }, total_findings: 1,
      review_tasks: 1, warning_count: 0, text_coverage: 'all_pages_have_text',
      semantic_assistance: 'not_requested', report_sha256: hash(body),
      authority_verified: false, notice: 'Issuer authority not verified.',
    }],
  };
  return { body, manifest, index };
}

type Fixture = ReturnType<typeof fixture>;

async function openIndex(page: Page, input: Fixture) {
  await page.goto('/?view=batch');
  await page.getByLabel('Batch index (up to 128 KiB)').setInputFiles(
    file('index.json', json(input.index)),
  );
  await expect(page.getByRole('heading', { name: '2. Saved batch summary' })).toBeVisible();
}

async function selectReport(page: Page, body: Buffer) {
  await page.getByLabel('Select saved case report (up to 8 MiB)').setInputFiles(
    file('case-001.json', body),
  );
}

test('navigation opens a local workspace and returns to the comparison', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Inspect saved batch' }).click();
  await expect(page.getByRole('heading', { name: 'Inspect a saved batch' })).toBeVisible();
  await page.getByRole('link', { name: 'Return to comparison' }).click();
  await expect(page.getByRole('heading', { name: 'Know when a notice changes.' })).toBeVisible();
});

test('loads a complete index and checks local manifest and report without API', async ({ page }) => {
  const apiCalls: string[] = [];
  await page.route('**/api/**', route => {
    apiCalls.push(route.request().url());
    return route.abort();
  });
  const input = fixture();
  await openIndex(page, input);
  await expect(page.getByText(/1 of 1 cases saved/)).toBeVisible();
  await page.getByLabel('Pinned manifest JSON (up to 64 KiB)').setInputFiles(
    file('manifest.json', input.manifest),
  );
  await expect(page.getByText(/Manifest bytes and listed source pins match/)).toBeVisible();
  await selectReport(page, input.body);
  await expect(page.getByText(/Report bytes match the saved digest/)).toBeVisible();
  await expect(page.getByText('Fictional deadline: 13 December')).toBeVisible();
  await expect(page.getByText('Fictional deadline: 19 December')).toBeVisible();
  await expect(page.getByText('private-original.pdf')).toHaveCount(0);
  await page.getByLabel('Saved finding type').selectOption('possible_change');
  await expect(page.getByText('No saved findings in this view.')).toBeVisible();
  await page.getByLabel('Saved finding type').selectOption('all');
  await expect(page.getByText('Fictional deadline: 13 December')).toBeVisible();
  await expect(page.getByText(/not been independently replayed/)).toBeVisible();
  expect(apiCalls).toEqual([]);
});

test('partial index never suggests that the batch completed', async ({ page }) => {
  const input = fixture({ partial: true });
  await openIndex(page, input);
  await expect(page.getByText(/Incomplete batch/)).toBeVisible();
  await expect(page.getByText(/1 of 2 cases saved/)).toBeVisible();
  await page.getByLabel('Pinned manifest JSON (up to 64 KiB)').setInputFiles(
    file('manifest.json', input.manifest),
  );
  await expect(page.getByText(/Manifest bytes and listed source pins match/)).toBeVisible();
});

test('a zero-completed partial batch has no inspectable case', async ({ page }) => {
  const input = fixture({ partial: true });
  input.index.completed_count = 0;
  input.index.cases = [];
  input.index.status_counts.confirmed_change = 0;
  await openIndex(page, input);
  await expect(page.getByText(/0 of 2 cases saved/)).toBeVisible();
  await expect(page.getByText('No completed cases match this view.')).toBeVisible();
  await expect(page.getByLabel('Select saved case report (up to 8 MiB)')).toHaveCount(0);
});

const invalidIndexes: [string, (input: Fixture) => void][] = [
  ['wrong schema version', input => { input.index.version = 2; }],
  ['false authority claim', input => { input.index.authority_verified = true; }],
  ['false completion', input => { input.index.complete = false; }],
  ['incorrect aggregate', input => { input.index.status_counts.confirmed_change = 9; }],
  ['incorrect row total', input => { input.index.cases[0].total_findings = 5; }],
  ['non-generated report path', input => { input.index.cases[0].report = '../private.json'; }],
  ['incorrect source fingerprint', input => { input.index.cases[0].source_fingerprints.original = 'bad'; }],
  ['bad report fingerprint', input => { input.index.cases[0].report_sha256 = 'bad'; }],
  ['unknown field', input => { Object.assign(input.index, { extra: 'private-field' }); }],
  ['unsafe case count', input => { input.index.case_count = 17; }],
];

for (const [label, mutate] of invalidIndexes) {
  test('rejects index: ' + label, async ({ page }) => {
    const input = fixture();
    mutate(input);
    await page.goto('/?view=batch');
    await page.getByLabel('Batch index (up to 128 KiB)').setInputFiles(
      file('index.json', json(input.index)),
    );
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('heading', { name: '2. Saved batch summary' })).toHaveCount(0);
    await expect(page.getByText('private-field')).toHaveCount(0);
  });
}

test('bad manifest bytes remove any earlier match', async ({ page }) => {
  const input = fixture();
  await openIndex(page, input);
  const control = page.getByLabel('Pinned manifest JSON (up to 64 KiB)');
  await control.setInputFiles(file('manifest.json', input.manifest));
  await expect(page.getByText(/Manifest bytes and listed source pins match/)).toBeVisible();
  await control.setInputFiles(file('manifest.json', Buffer.from('{}')));
  await expect(page.getByRole('alert')).toHaveText(
    'The selected bytes do not match the saved fingerprint.',
  );
  await expect(page.getByText(/Manifest bytes and listed source pins match/)).toHaveCount(0);
});

test('manifest digest alone is insufficient when listed pins disagree', async ({ page }) => {
  const input = fixture();
  const data = JSON.parse(input.manifest.toString());
  data.cases[0].original_sha256 = 'e'.repeat(64);
  input.manifest = json(data);
  input.index.manifest_sha256 = hash(input.manifest);
  await openIndex(page, input);
  await page.getByLabel('Pinned manifest JSON (up to 64 KiB)').setInputFiles(
    file('manifest.json', input.manifest),
  );
  await expect(page.getByRole('alert')).toHaveText(
    'The document roles or saved source fingerprints disagree.',
  );
});

test('modified report clears previously displayed quotes', async ({ page }) => {
  const input = fixture();
  await openIndex(page, input);
  await selectReport(page, input.body);
  await expect(page.getByText('Fictional deadline: 13 December')).toBeVisible();
  await selectReport(page, Buffer.from('{}'));
  await expect(page.getByRole('alert')).toHaveText(
    'The selected bytes do not match the saved fingerprint.',
  );
  await expect(page.getByText('Fictional deadline: 13 December')).toHaveCount(0);
});

const invalidReports: [string, (saved: ReturnType<typeof report>) => void][] = [
  ['unexpected OCR', saved => { saved.automatic_ocr = true; }],
  ['unexpected AI', saved => { saved.semantic_assistance = 'proposals_added'; }],
  ['false authority', saved => { saved.findings[0].authority_verified = true; }],
  ['inconsistent counts', saved => { saved.findings[0].status = 'possible_change'; }],
  ['missing checklist', saved => { saved.checklist = []; }],
  ['invalid quote page', saved => { saved.findings[0].original.page = 0; }],
  ['wrong source role', saved => { saved.documents[0].id = 'revised'; }],
  ['wrong fingerprint', saved => { saved.documents[0].sha256 = 'e'.repeat(64); }],
];

for (const [label, mutate] of invalidReports) {
  test('rejects digest-matched inconsistent report: ' + label, async ({ page }) => {
    const saved = report();
    mutate(saved);
    const input = fixture({ saved });
    await openIndex(page, input);
    await selectReport(page, input.body);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText(/Report bytes match the saved digest/)).toHaveCount(0);
    await expect(page.getByText('Fictional deadline: 13 December')).toHaveCount(0);
  });
}

test('same-page contradiction previews both supporting quotes', async ({ page }) => {
  const saved = report();
  const finding = {
    ...saved.findings[0], status: 'contradiction', original: null, revised: null,
    supporting_evidence: [
      evidence('original', 'Fictional deadline: 13 December'),
      evidence('original', 'Fictional deadline: 19 December'),
    ],
  };
  const input = fixture({ saved: { ...saved, findings: [finding] } });
  input.index.status_counts.confirmed_change = 0;
  input.index.status_counts.contradiction = 1;
  input.index.cases[0].status_counts = { ...input.index.status_counts };
  await openIndex(page, input);
  await selectReport(page, input.body);
  await expect(page.getByText(/Finding 1 · Conflicting dates/)).toBeVisible();
  await expect(page.getByText('Fictional deadline: 13 December')).toBeVisible();
  await expect(page.getByText('Fictional deadline: 19 December')).toBeVisible();
});

test('saved quote markup is displayed as text, not executable HTML', async ({ page }) => {
  const saved = report();
  saved.findings[0].original.text = '<img src=x onerror="alert(1)">';
  const input = fixture({ saved });
  await openIndex(page, input);
  await selectReport(page, input.body);
  await expect(page.getByText(saved.findings[0].original.text, { exact: true })).toBeVisible();
  await expect(page.locator('.batch-quote img')).toHaveCount(0);
});

test('clear workspace removes all saved counts and quotes', async ({ page }) => {
  const input = fixture();
  await openIndex(page, input);
  await selectReport(page, input.body);
  await expect(page.getByText('Fictional deadline: 13 December')).toBeVisible();
  await page.getByRole('button', { name: 'Clear workspace' }).click();
  await expect(page.getByRole('heading', { name: '2. Saved batch summary' })).toHaveCount(0);
  await expect(page.getByText('Fictional deadline: 13 December')).toHaveCount(0);
});

test('coverage filter and narrow mobile layout remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const input = fixture();
  await openIndex(page, input);
  await page.getByLabel('Text coverage filter').selectOption('limited');
  await expect(page.getByText('No completed cases match this view.')).toBeVisible();
  await page.getByLabel('Text coverage filter').selectOption('all');
  await expect(page.getByRole('button', { name: 'Case 1 details' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321);
});


// Construct a small valid PDF with computed byte offsets; use no private or
// external document. The browser PDF.js renderer must actually open it.
function fictionalPdf(day: number): Buffer {
  const stream = 'BT /F1 12 Tf 40 720 Td (Application deadline: ' + day + ' December) Tj ET\n';
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + 'endstream',
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  bodies.forEach((body, i) => {
    offsets.push(Buffer.byteLength(text));
    text += (i + 1) + ' 0 obj\n' + body + '\nendobj\n';
  });
  const xref = Buffer.byteLength(text);
  text += 'xref\n0 6\n0000000000 65535 f \n';
  offsets.slice(1).forEach(offset => {
    text += String(offset).padStart(10, '0') + ' 00000 n \n';
  });
  text += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(text, 'ascii');
}

function sourceFixture(options: { geometry?: boolean; page?: number } = {}) {
  const old = fictionalPdf(13);
  const updated = fictionalPdf(19);
  const saved = report();
  const fingerprints = { original: hash(old), revised: hash(updated) };
  saved.documents[0].sha256 = fingerprints.original;
  saved.documents[1].sha256 = fingerprints.revised;
  if (options.page) saved.findings[0].original.page = options.page;
  if (options.geometry) {
    Object.assign(saved.findings[0].original, {
      bbox: [40, 58, 235, 76], page_width: 612, page_height: 792, page_rotation: 0,
    });
    Object.assign(saved.findings[0].revised, {
      bbox: [40, 58, 235, 76], page_width: 612, page_height: 792, page_rotation: 0,
    });
  }
  const input = fixture({ saved });
  input.index.cases[0].source_fingerprints = fingerprints;
  const manifest = JSON.parse(input.manifest.toString());
  manifest.cases[0].original_sha256 = fingerprints.original;
  manifest.cases[0].revised_sha256 = fingerprints.revised;
  input.manifest = json(manifest);
  input.index.manifest_sha256 = hash(input.manifest);
  return { input, old, updated };
}

async function attachPdf(page: Page, role: 'Original notice' | 'Updated notice', bytes: Buffer,
  name = 'local.pdf') {
  await page.getByLabel(role + ' PDF for this case').setInputFiles({
    name, buffer: bytes, mimeType: 'application/pdf',
  });
}

async function openSourceCase(page: Page, options: { geometry?: boolean; page?: number } = {}) {
  const files = sourceFixture(options);
  await openIndex(page, files.input);
  await selectReport(page, files.input.body);
  await expect(page.getByText(/Report bytes match the saved digest/)).toBeVisible();
  return files;
}

test('renders only a fingerprint-matched source PDF with the saved rectangle', async ({ page }) => {
  const files = await openSourceCase(page, { geometry: true });
  await page.getByRole('button', { name: 'Inspect original notice page 1' }).click();
  await expect(page.getByText(/Attach the matching original notice PDF above/)).toBeVisible();
  await expect(page.locator('.batch-page-panel canvas')).toHaveCount(0);
  await attachPdf(page, 'Original notice', files.old);
  await expect(page.getByText('Original notice PDF bytes match the saved fingerprint.')).toBeVisible();
  await expect(page.locator('.batch-page-panel canvas')).toBeVisible();
  await expect(page.locator('.batch-page-panel .evidence-highlight')).toBeVisible();
  await expect(page.getByText('1 of 2 PDF fingerprints matched.')).toBeVisible();
  await attachPdf(page, 'Updated notice', files.updated);
  await expect(page.getByText('2 of 2 PDF fingerprints matched.')).toBeVisible();
  await page.getByRole('button', { name: 'Inspect updated notice page 1' }).click();
  await expect(page.getByRole('heading', { name: 'Updated notice · page 1' })).toBeFocused();
  await expect(page.locator('.batch-page-panel .evidence-highlight')).toBeVisible();
});

test('role-swapped PDF does not reach the renderer', async ({ page }) => {
  const files = await openSourceCase(page);
  await page.getByRole('button', { name: 'Inspect original notice page 1' }).click();
  await attachPdf(page, 'Original notice', files.updated);
  await expect(page.getByRole('alert')).toHaveText(
    'PDF bytes do not match this saved source fingerprint.',
  );
  await expect(page.locator('.batch-page-panel canvas')).toHaveCount(0);
  await expect(page.getByText('0 of 2 PDF fingerprints matched.')).toBeVisible();
});

test('replacing a checked PDF with unrelated bytes clears its source preview', async ({ page }) => {
  const files = await openSourceCase(page, { geometry: true });
  await attachPdf(page, 'Original notice', files.old);
  await expect(page.getByText('Original notice PDF bytes match the saved fingerprint.')).toBeVisible();
  await page.getByRole('button', { name: 'Inspect original notice page 1' }).click();
  await expect(page.locator('.batch-page-panel .evidence-highlight')).toBeVisible();
  await attachPdf(page, 'Original notice', files.updated);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.batch-page-panel canvas')).toHaveCount(0);
  await expect(page.locator('.batch-page-panel .evidence-highlight')).toHaveCount(0);
});

test('missing geometry displays a page without fabricating a highlight', async ({ page }) => {
  const files = await openSourceCase(page);
  await attachPdf(page, 'Original notice', files.old);
  await page.getByRole('button', { name: 'Inspect original notice page 1' }).click();
  await expect(page.getByText('Source page shown without a verified highlight.')).toBeVisible();
  await expect(page.locator('.batch-page-panel .evidence-highlight')).toHaveCount(0);
});

test('out-of-range saved page does not render as another page', async ({ page }) => {
  const files = await openSourceCase(page, { page: 2 });
  await attachPdf(page, 'Original notice', files.old);
  await page.getByRole('button', { name: 'Inspect original notice page 2' }).click();
  await expect(page.getByRole('alert')).toHaveText('Requested page is outside the source PDF.');
  await expect(page.locator('.batch-page-panel .evidence-highlight')).toHaveCount(0);
});

test('clearing attached sources closes the active source preview', async ({ page }) => {
  const files = await openSourceCase(page);
  await attachPdf(page, 'Original notice', files.old);
  await page.getByRole('button', { name: 'Inspect original notice page 1' }).click();
  await expect(page.getByText('Source page shown without a verified highlight.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear attached PDFs' }).click();
  await expect(page.locator('.batch-page-panel')).toHaveCount(0);
  await expect(page.getByText('0 of 2 PDF fingerprints matched.')).toBeVisible();
});

test('rejects a non-PDF filename even when the file bytes match', async ({ page }) => {
  const files = await openSourceCase(page);
  await attachPdf(page, 'Original notice', files.old, 'not-a-pdf.txt');
  await expect(page.getByRole('alert')).toHaveText('Choose a PDF with a valid PDF signature.');
});

test('rejects a non-PDF signature before checking the stored digest', async ({ page }) => {
  await openSourceCase(page);
  await attachPdf(page, 'Original notice', Buffer.from('not a PDF'));
  await expect(page.getByRole('alert')).toHaveText('Choose a PDF with a valid PDF signature.');
});

test('rejects empty and oversized source PDFs', async ({ page }) => {
  await openSourceCase(page);
  await attachPdf(page, 'Original notice', Buffer.alloc(0));
  await expect(page.getByRole('alert')).toHaveText('Choose a nonempty PDF no larger than 10 MiB.');
  const large = Buffer.alloc(10 * 1024 * 1024 + 1, 32);
  large.write('%PDF-');
  await attachPdf(page, 'Original notice', large);
  await expect(page.getByRole('alert')).toHaveText('Choose a nonempty PDF no larger than 10 MiB.');
});

test('clearing the workspace releases source attachments and report quotations', async ({ page }) => {
  const files = await openSourceCase(page);
  await attachPdf(page, 'Original notice', files.old);
  await expect(page.getByText('Original notice PDF bytes match the saved fingerprint.')).toBeVisible();
  await page.getByRole('button', { name: 'Inspect original notice page 1' }).click();
  await expect(page.getByText('Source page shown without a verified highlight.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear workspace' }).click();
  await expect(page.locator('.batch-page-panel')).toHaveCount(0);
  await expect(page.getByLabel('Original notice PDF for this case')).toHaveCount(0);
  await expect(page.getByText('Fictional deadline: 13 December')).toHaveCount(0);
});

test('source inspection sends neither PDFs nor evidence to the API', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/api/**', route => {
    requests.push(route.request().url());
    return route.abort();
  });
  const files = await openSourceCase(page);
  await attachPdf(page, 'Original notice', files.old);
  await page.getByRole('button', { name: 'Inspect original notice page 1' }).click();
  await expect(page.getByText('Source page shown without a verified highlight.')).toBeVisible();
  expect(requests).toEqual([]);
});
