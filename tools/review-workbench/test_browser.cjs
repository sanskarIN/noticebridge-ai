/* Real loopback navigation, WebCrypto, CSP and downloads using the pinned frontend Playwright. */
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile, mkdtemp, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { chromium, expect } = require('../../frontend/node_modules/@playwright/test');

const assets = {
  '/index.html': 'text/html; charset=utf-8',
  '/core.js': 'text/javascript; charset=utf-8',
  '/ui.js': 'text/javascript; charset=utf-8',
  '/style.css': 'text/css; charset=utf-8',
};
const example = name => join(__dirname, 'example', name);

async function run() {
  const server = createServer(async (request, response) => {
    const url = request.url;
    if (request.method !== 'GET' || !Object.hasOwn(assets, url)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const data = await readFile(join(__dirname, url.slice(1)));
      response.writeHead(200, { 'Content-Type': assets[url], 'Cache-Control': 'no-store' }).end(data);
    } catch {
      response.writeHead(500).end();
    }
  });
  const folder = await mkdtemp(join(tmpdir(), 'nb-workbench-'));
  let browser;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch();
    const page = await browser.newPage({ acceptDownloads: true });
    const errors = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith(origin + '/')) {
        external.push(request.url());
      }
    });
    page.on('dialog', dialog => dialog.accept());
    await page.goto(origin + '/index.html');
    assert(await page.evaluate(() => isSecureContext && Boolean(crypto.subtle)));
    await page.locator('#manifest').setInputFiles(example('source.json'));
    await expect(page.locator('#progress')).toHaveText('0 / 1 complete');
    const inputs = page.locator('#sources input[type=file]');
    // Wait for each SHA-256 check to finish before moving to the next input.
    // Rapidly setting two file controls can leave a WebCrypto digest pending
    // on a heavily loaded CI runner. Both exact fingerprints are still required.
    const verifySource = async (index, filename) => {
      const panel = page.locator('#sources .source').nth(index);
      await panel.locator('input[type=file]').setInputFiles(example(filename));
      await expect(panel.getByText('Exact SHA-256 fingerprint matched.', { exact: true }))
        .toHaveCount(1, { timeout: 15_000 });
      await expect(panel.getByRole('button', { name: 'Open verified PDF' })).toBeEnabled();
    };

    await inputs.nth(0).setInputFiles(example('revised.pdf'));
    await expect(page.locator('#sources .error')).toContainText('SHA-256 mismatch');
    await verifySource(0, 'original.pdf');
    await verifySource(1, 'revised.pdf');
    await expect(page.getByText('Exact SHA-256 fingerprint matched.', { exact: true })).toHaveCount(2);
    await page.locator('#add').click();
    const quotes = page.locator('#pairs textarea');
    await quotes.nth(0).fill('Application deadline: 13 December 2026');
    await quotes.nth(1).fill('Application deadline: 19 December 2026');
    await page.locator('#attest').check();
    await page.locator('#complete').click();
    await expect(page.locator('#progress')).toHaveText('1 / 1 complete');
    await quotes.nth(1).fill('Incomplete edit');
    await expect(page.locator('#export')).toBeDisabled();
    const draftWait = page.waitForEvent('download');
    await page.locator('#draft').click();
    const draft = join(folder, 'draft.json');
    await (await draftWait).saveAs(draft);
    assert.equal(JSON.parse(await readFile(draft, 'utf8')).format, 'noticebridge-review-draft');
    await page.locator('#resume').setInputFiles(draft);
    await expect(quotes.nth(1)).toHaveValue('Incomplete edit');
    await expect(page.locator('#complete')).toBeDisabled();
    await verifySource(0, 'original.pdf');
    await verifySource(1, 'revised.pdf');
    await expect(page.getByText('Exact SHA-256 fingerprint matched.', { exact: true })).toHaveCount(2);
    await quotes.nth(1).fill('Application deadline: 19 December 2026');
    await page.locator('#attest').check();
    await page.locator('#complete').click();
    const finalWait = page.waitForEvent('download');
    await page.locator('#export').click();
    const final = join(folder, 'review.json');
    await (await finalWait).saveAs(final);
    const review = JSON.parse(await readFile(final, 'utf8'));
    const source = JSON.parse(await readFile(example('source.json'), 'utf8'));
    assert.equal(review.version, 2);
    assert.equal(review.cases[0].review_complete, true);
    assert.equal(review.cases[0].original_sha256, source.cases[0].original_sha256);
    assert.deepEqual(review.cases[0].expected_pairs, [{
      original_page: 1, original_text: 'Application deadline: 13 December 2026',
      revised_page: 1, revised_text: 'Application deadline: 19 December 2026',
    }]);
    await page.setViewportSize({ width: 375, height: 820 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log('PASS: workbench loopback, native SHA-256, draft and final downloads, responsive UI');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
