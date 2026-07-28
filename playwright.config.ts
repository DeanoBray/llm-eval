import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
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
