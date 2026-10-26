import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 15_000,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'https://offline-ui-contract.invalid',
    serviceWorkers: 'block',
    trace: 'on-first-retry',
  },
});
