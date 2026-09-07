import { E2E_APP_URL, E2E_SERVER_TOKEN } from '../config';
import {
  api,
  command,
  expect,
  expectNoBrowserErrors,
  test,
  unlockDashboard,
  visit,
} from './helpers';

test('applies stall and DLQ policy, promotes delayed jobs and reads SDK telemetry', async ({
  page,
  request,
  browserErrors,
}) => {
  const queue = 'managed-queue-policy';
  const seed = await request.post(`${E2E_APP_URL}/api/queues/${queue}/jobs`, {
    headers: { Authorization: `Bearer ${E2E_SERVER_TOKEN}` },
    data: { data: { queuePolicy: true }, delay: 120000 },
  });
  expect(seed.ok()).toBe(true);
  await unlockDashboard(page);
  await visit(page, '/queue-control');
  await page.getByLabel('Queue', { exact: true }).selectOption(queue);
  await page.getByLabel('Stall interval (ms)').fill('45000');
  await page.getByLabel('Max stalls').fill('4');
  await page.getByLabel('Grace period (ms)').fill('8000');
  const stall = page
    .getByRole('heading', { name: 'Stall detection', exact: true })
    .locator('../..');
  await command(page, `/queues/${queue}/stall-config`, () =>
    stall.getByRole('button', { name: 'Save', exact: true }).click()
  );
  expect((await api(request, `/api/queues/${queue}/stall-config`)).config).toMatchObject({
    stallInterval: 45000,
    maxStalls: 4,
    gracePeriod: 8000,
  });
  await page.getByLabel('Retry interval (ms)').fill('120000');
  await page.getByLabel('Max auto-retries').fill('5');
  const dlq = page.getByRole('heading', { name: 'DLQ policy', exact: true }).locator('../..');
  await expect(page.getByLabel('Max age (ms)')).toBeDisabled();
  await expect(page.getByLabel('Max entries')).toBeDisabled();
  await command(page, `/queues/${queue}/dlq-config`, () =>
    dlq.getByRole('button', { name: 'Save', exact: true }).click()
  );
  expect((await api(request, `/api/queues/${queue}/dlq-config`)).config).toMatchObject({
    autoRetryInterval: 120000,
    maxAutoRetries: 5,
    autoRetry: false,
  });
  await page.getByLabel('Promote N').fill('1');
  page.once('dialog', (dialog) => dialog.accept());
  await command(page, `/queues/${queue}/promote-jobs`, () =>
    page.getByRole('button', { name: 'Promote delayed', exact: true }).click()
  );
  expect((await api(request, `/api/queues/${queue}/counts`)).counts.waiting).toBe(1);
  for (const action of ['Drain', 'Clean', 'Requeue completed']) {
    await expect(page.getByRole('button', { name: new RegExp(`^${action}`) })).toBeDisabled();
  }
  for (const metric of ['completed', 'failed']) {
    await page.getByLabel('Metric', { exact: true }).selectOption(metric);
    const read = page.waitForResponse(
      (r) => r.url().includes('/metrics') && r.url().includes('/agent/')
    );
    await page.getByRole('button', { name: 'Read metrics', exact: true }).click();
    expect((await read).ok()).toBe(true);
  }
  await page.getByLabel('Retain lifecycle events').fill('100');
  page.once('dialog', (dialog) => dialog.accept());
  const trimmed = page.waitForResponse(
    (r) => r.url().includes('/agent/queue-operations/') && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Trim journal', exact: true }).click();
  expect((await trimmed).ok()).toBe(true);
  expectNoBrowserErrors(browserErrors);
});

test('persists appearance and refresh settings and verifies managed start, stop, restart and logs', async ({
  page,
  request,
  browserErrors,
}) => {
  await unlockDashboard(page);
  await visit(page, '/settings');
  await page.getByLabel('Theme', { exact: true }).selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByLabel('Refresh interval', { exact: true }).selectOption('1000');
  await page.reload();
  await unlockDashboard(page);
  await visit(page, '/settings');
  await expect(page.getByLabel('Theme', { exact: true })).toHaveValue('light');
  await expect(page.getByLabel('Refresh interval', { exact: true })).toHaveValue('1000');
  await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  await visit(page, '/server');
  const generation = (await api(request, '/agent/control/status')).generation;
  page.once('dialog', (dialog) => dialog.accept());
  await command(page, '/control/restart', () =>
    page.getByRole('button', { name: 'Restart', exact: true }).click()
  );
  await expect
    .poll(async () => (await api(request, '/agent/control/status')).generation)
    .toBeGreaterThan(generation);
  await page.getByLabel('Filter log lines').fill('Server');
  await expect(
    page
      .getByRole('heading', { name: 'Process logs', exact: true })
      .locator('../..')
      .locator('.whitespace-pre-wrap')
      .first()
  ).toBeVisible();
  await page.getByLabel('Filter log lines').fill('');
  expectNoBrowserErrors(browserErrors);
});
