import type { Page } from '@playwright/test';
import { E2E_APP_URL, E2E_BASE_PATH, E2E_SEED_QUEUE } from './config';
import { control, expect, expectNoBrowserErrors, test, unlockDashboard } from './fixtures';

async function navigateInApp(page: Page, path: string, expectedPath = path): Promise<void> {
  await page.evaluate(
    ({ basePath, route }) => {
      window.history.pushState({}, '', `${basePath}${route}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    },
    { basePath: E2E_BASE_PATH, route: path }
  );
  await expect(page).toHaveURL(`${E2E_APP_URL}${expectedPath}`);
}

test.beforeEach(async ({ request }) => {
  await control(request, '/upstream/start');
});

test('renders every off-navigation classic route against a real Bunqueue server', async ({
  page,
  browserErrors,
}) => {
  await unlockDashboard(page);

  const routes = [
    ['/overview-classic', 'Overview'],
    ['/queues-classic', 'Queues'],
    [`/queues-classic/${E2E_SEED_QUEUE}`, E2E_SEED_QUEUE],
    ['/jobs-classic', 'Jobs Explorer'],
    ['/dlq-classic', 'Dead Letter Queue'],
    ['/cron-classic', 'Cron Jobs'],
    ['/metrics-classic', 'Metrics'],
    ['/workers-classic', 'Workers'],
    ['/logs-classic', 'Activity Logs'],
    ['/usage-classic', 'Usage'],
    ['/s3-classic', 'S3 Backup'],
  ] as const;

  for (const [path, heading] of routes) {
    await navigateInApp(page, path);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await expect(page.getByText('This page does not exist.')).toHaveCount(0);
  }

  expectNoBrowserErrors(browserErrors);
});

test('redirects the legacy cron route and renders the wildcard fallback', async ({
  page,
  browserErrors,
}) => {
  await unlockDashboard(page);
  await navigateInApp(page, '/cron-manager', '/cron');
  await expect(page).toHaveURL(`${E2E_APP_URL}/cron`);
  await expect(page.getByRole('heading', { name: 'Cron Manager', level: 1 })).toBeVisible();

  await navigateInApp(page, '/definitely-not-a-route');
  await expect(page.getByRole('heading', { name: '404', level: 1 })).toBeVisible();
  await expect(page.getByText('This page does not exist.')).toBeVisible();
  expectNoBrowserErrors(browserErrors);
});
