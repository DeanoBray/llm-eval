import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // e2e tests use the .e2e.ts suffix. The .spec.ts suffix is shared with
  // vitest (used in other repos) — this keeps the two runners unambiguous.
  testMatch: /.*\.e2e\.ts/,
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:3007',
    headless: true,
  },
  webServer: {
    command: 'node dist/web/server.js',
    url: 'http://localhost:3007/api/health',
    reuseExistingServer: false,
    cwd: '.',
  },
});
