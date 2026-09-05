import { E2E_APP_URL, E2E_BASE_PATH, E2E_SEED_QUEUE, E2E_SERVER_TOKEN } from './config';
import { control, expect, expectNoBrowserErrors, test, unlockDashboard } from './fixtures';

test.beforeEach(async ({ page, request }) => {
  await control(request, '/upstream/start');
  await unlockDashboard(page);
});

test('shows live queue metrics, storage health and the real worker registry', async ({
  page,
  browserErrors,
}) => {
  await page.locator(`#app-nav a[href="${E2E_BASE_PATH}/metrics"]`).click();
  await expect(page.getByRole('row').filter({ hasText: E2E_SEED_QUEUE })).toBeVisible();
  await expect(page.locator('#main').getByText('Live', { exact: true })).toBeVisible();
  await page.locator(`#app-nav a[href="${E2E_BASE_PATH}/usage"]`).click();
  await expect(page.getByText('Disk writes are being accepted.')).toBeVisible();
  await expect(page.getByText('Jobs pushed (since restart)')).toBeVisible();
  const workers = page.waitForResponse((r) => r.url().endsWith('/api/workers') && r.ok());
  await page.locator(`#app-nav a[href="${E2E_BASE_PATH}/workers"]`).click();
  expect((await (await workers).json()).data.workers).toEqual([]);
  await expect(page.getByText('No workers registered', { exact: true })).toBeVisible();
  expectNoBrowserErrors(browserErrors);
});

test('receives a real job event in Logs and filters it', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const queue = `logs-${testInfo.project.name}`;
  await page.locator(`#app-nav a[href="${E2E_BASE_PATH}/logs"]`).click();
  await expect(page.getByRole('heading', { name: 'Activity Logs', exact: true })).toBeVisible();
  await expect(page.locator('#main').getByText('Live', { exact: true })).toBeVisible();
  await control(request, '/jobs', { queue });
  await expect(page.getByRole('row').filter({ hasText: queue })).toBeVisible();
  await page.getByRole('textbox').fill('no-matching-e2e-event');
  await expect(page.getByRole('row').filter({ hasText: queue })).toHaveCount(0);
  await page.getByRole('textbox').fill(queue);
  await expect(page.getByRole('row').filter({ hasText: queue })).toBeVisible();
  expectNoBrowserErrors(browserErrors);
});

test('evaluates an alert against a real waiting job and removes the rule', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const queue = `alerts-${testInfo.project.name}`;
  const name = `Waiting evidence ${testInfo.project.name}`;
  await control(request, '/jobs', { queue });
  await page.locator(`#app-nav a[href="${E2E_BASE_PATH}/alerts"]`).click();
  await page.getByRole('button', { name: '+ Create Alert Rule' }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Metric', { exact: true }).selectOption('waiting');
  await page.getByLabel('Threshold', { exact: true }).fill('1');
  await page.getByLabel('Queue (optional)').fill(queue);
  await page.getByRole('button', { name: 'Save rule' }).click();
  const triggered = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Triggered Alerts' }) });
  await expect(triggered.getByRole('row').filter({ hasText: name })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: `Delete rule ${name}` }).click();
  await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);
  expectNoBrowserErrors(browserErrors);
});

test('shows a real failed job in both DLQ views and preserves disabled destructive actions', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const queue = `failure-${testInfo.project.name}`;
  const headers = { Authorization: `Bearer ${E2E_SERVER_TOKEN}` };
  const created = await request.post(`${E2E_APP_URL}/api/queues/${queue}/jobs`, {
    headers,
    data: { name: 'expected-failure', data: { evidence: 'dlq' }, maxAttempts: 1 },
  });
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  const pulled = await request.post(`${E2E_APP_URL}/api/queues/${queue}/jobs/pull-batch`, {
    headers,
    data: { count: 1 },
  });
  expect(pulled.ok()).toBe(true);
  const failed = await request.post(`${E2E_APP_URL}/api/jobs/${id}/fail`, {
    headers,
    data: { error: 'deliberate-browser-evidence', unrecoverable: true },
  });
  expect(failed.ok()).toBe(true);
  for (const route of ['/dlq', '/dlq-control']) {
    await page.locator(`#app-nav a[href="${E2E_BASE_PATH}${route}"]`).click();
    await expect(page).toHaveURL(`${E2E_APP_URL}${route}`);
    await expect(
      page.getByRole('heading', {
        name: route === '/dlq' ? 'Dead Letter Queue' : 'DLQ Control',
        exact: true,
      })
    ).toBeVisible();
    await page.getByRole('combobox', { name: 'Queue', exact: true }).selectOption(queue);
    await expect(page.getByRole('combobox', { name: 'Queue', exact: true })).toHaveValue(queue);
    await expect(
      page.getByRole('row').filter({ has: page.locator(`a[href="${E2E_BASE_PATH}/job?id=${id}"]`) })
    ).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Purge', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry all', exact: true })).toBeDisabled();
  expectNoBrowserErrors(browserErrors);
});
