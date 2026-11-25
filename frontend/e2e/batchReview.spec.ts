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
