import { defineConfig } from '@playwright/test';

const URL = 'http://127.0.0.1:4173/noticebridge/';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/showcase.offline.spec.ts',
  timeout: 45_000,
  outputDir: 'test-results/showcase',
  use: { baseURL: URL, browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run preview -- --outDir dist-showcase --base /noticebridge/ --host 127.0.0.1 --port 4173 --strictPort',
    url: URL,
    reuseExistingServer: !process.env.CI,
  },
});
