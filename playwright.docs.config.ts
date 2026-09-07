import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/docs',
  testMatch: '**/*.docs.ts',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  outputDir: 'test-results/docs',
  use: {
    baseURL: 'http://127.0.0.1:49556',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun run docs:preview --host 127.0.0.1 --port 49556',
    url: 'http://127.0.0.1:49556',
    reuseExistingServer: false,
    timeout: 30_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
});
