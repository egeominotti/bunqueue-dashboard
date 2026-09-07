import { defineConfig, devices } from '@playwright/test';
import { E2E_APP_URL, E2E_CONTROL_URL } from './e2e/config';

export default defineConfig({
  testDir: './e2e/managed',
  testMatch: '**/*.managed.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results/managed',
  use: {
    baseURL: E2E_APP_URL,
    colorScheme: 'dark',
    locale: 'en-US',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun e2e/managed/runtime.ts',
    url: `${E2E_CONTROL_URL}/health`,
    timeout: 30_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
