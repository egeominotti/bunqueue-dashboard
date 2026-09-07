import type { APIRequestContext, Page } from '@playwright/test';
import packageJson from '../package.json' with { type: 'json' };
import { E2E_APP_URL, E2E_SERVER_TOKEN } from './config';
import { control, expect, expectNoBrowserErrors, test, unlockDashboard } from './fixtures';

async function visit(page: Page, route: string): Promise<void> {
  await page.locator(`#app-nav nav a[href="/e2e/dashboard${route}"]`).click();
  await expect(page).toHaveURL(`${E2E_APP_URL}${route}`);
}

async function read(request: APIRequestContext, path: string) {
  const response = await request.get(`${E2E_APP_URL}/api${path}`, {
    headers: { Authorization: `Bearer ${E2E_SERVER_TOKEN}` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test.beforeEach(async ({ page, request }) => {
  await control(request, '/upstream/start');
  await unlockDashboard(page);
});

test('enqueues from Add Job, inspects persisted data and imports a real bulk', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const queue = `operations-${testInfo.project.name}-${testInfo.retry}`;
  await visit(page, '/add-job');
  await page.getByLabel('Queue', { exact: true }).fill(queue);
  await page.getByLabel('Job name', { exact: true }).fill('verified-job');
  await page.getByLabel('Data (JSON)').fill('{"evidence":"browser-persisted","amount":42}');
  const accepted = page.waitForResponse(
    (r) => r.url().endsWith(`/api/queues/${queue}/jobs`) && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Add job', exact: true }).click();
  const response = await accepted;
  expect(response.ok()).toBe(true);
  const body = await response.json();
  const id = String(body.id);
  expect(id).not.toBe('undefined');
  await expect(page.getByText(`Accepted job ID ${id}`, { exact: false })).toBeVisible();
  const persisted = await read(request, `/jobs/${id}`);
  expect(persisted.job.data).toEqual({ evidence: 'browser-persisted', amount: 42 });

  await visit(page, '/queues');
  await expect(page.getByRole('link', { name: queue, exact: true })).toBeVisible();
  await page.getByRole('link', { name: queue, exact: true }).click();
  await expect(page.getByRole('heading', { name: queue, exact: true })).toBeVisible();
  await visit(page, '/job');
  await page.getByLabel('Job ID', { exact: true }).fill(id);
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(
    page.locator('#main').getByText('browser-persisted', { exact: false })
  ).toBeVisible();

  await visit(page, '/jobs/bulk-add');
  await page.getByLabel('Queue', { exact: true }).fill(queue);
  await page.getByLabel('Jobs JSON').fill(
    JSON.stringify([
      { name: 'bulk-one', data: { n: 1 } },
      { name: 'bulk-two', data: { n: 2 } },
    ])
  );
  const imported = page.waitForResponse(
    (r) => r.url().endsWith(`/api/queues/${queue}/jobs/bulk`) && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: /Import/u }).click();
  expect((await imported).ok()).toBe(true);
  await expect
    .poll(async () => (await read(request, `/queues/${queue}/counts`)).counts.waiting)
    .toBe(3);
  expectNoBrowserErrors(browserErrors);
});

test('runs a real 40-job producer and worker benchmark and reconciles server counts', async ({
  page,
  request,
  browserErrors,
}) => {
  await visit(page, '/benchmark');
  const queue = await page.getByLabel('Dedicated queue').inputValue();
  await page.getByLabel('Total jobs').fill('40');
  await page.locator('[name="benchmark-producers"]').fill('2');
  await page.getByLabel('Push batch').fill('10');
  await page.locator('[name="benchmark-workers"]').fill('2');
  await page.getByLabel('Pull batch').fill('5');
  await page.getByLabel('Process (ms)').fill('1');
  await page.getByRole('switch', { name: 'Remove on complete', exact: true }).uncheck();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Run benchmark' }).click();
  await expect(page.getByRole('heading', { name: 'Summary', exact: true })).toBeVisible();
  await expect
    .poll(async () => (await read(request, `/queues/${queue}/counts`)).counts)
    .toMatchObject({ waiting: 0, active: 0, completed: 40, failed: 0 });
  expectNoBrowserErrors(browserErrors);
});

test('reads live diagnostics and executes a real SQLite query', async ({ page, browserErrors }) => {
  await visit(page, '/diagnostics');
  await expect(
    page.getByText(`v${packageJson.dependencies.bunqueue}`, { exact: true })
  ).toBeVisible();
  const ping = page.waitForResponse((r) => r.url().endsWith('/api/ping'));
  await page.getByRole('button', { name: 'Ping', exact: true }).click();
  expect((await ping).ok()).toBe(true);
  await expect(page.getByRole('button', { name: /Ping ·/u })).toBeVisible();
  await visit(page, '/database');
  await page.getByLabel('SQL query').fill("SELECT 'browser-sql-verified' AS evidence");
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'browser-sql-verified', exact: true })).toBeVisible();
  expectNoBrowserErrors(browserErrors);
});

test('creates, disables and deletes a webhook registry entry without external delivery', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const queue = `webhook-unused-${testInfo.project.name}`;
  const url = 'https://dashboard-webhook.invalid/browser-webhook';
  await visit(page, '/webhooks');
  await page.getByLabel('URL', { exact: true }).fill(url);
  await page.getByLabel('Queue (optional)').fill(queue);
  await page.getByRole('button', { name: 'Add webhook', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: queue });
  await expect(row).toBeVisible();
  await row.getByRole('switch', { name: 'Disable webhook' }).click();
  await expect
    .poll(async () => {
      const registry = await read(request, '/webhooks');
      return registry.data.webhooks.find((hook: { queue: string }) => hook.queue === queue)
        ?.enabled;
    })
    .toBe(false);
  page.once('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: 'Remove webhook' }).click();
  await expect(row).toHaveCount(0);
  const registry = await read(request, '/webhooks');
  expect(registry.data.webhooks.some((hook: { queue: string }) => hook.queue === queue)).toBe(
    false
  );
  expectNoBrowserErrors(browserErrors);
});
