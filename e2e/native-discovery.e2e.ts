import type { APIRequestContext, Page } from '@playwright/test';
import { E2E_APP_URL, E2E_BASE_PATH, E2E_SERVER_TOKEN } from './config';
import {
  control,
  expect,
  expectAccessible,
  expectNoBrowserErrors,
  test,
  unlockDashboard,
} from './fixtures';

async function native(request: APIRequestContext, path: string, data?: Record<string, unknown>) {
  const response = await request.fetch(`${E2E_APP_URL}/api${path}`, {
    headers: { Authorization: `Bearer ${E2E_SERVER_TOKEN}` },
    method: data ? 'POST' : 'GET',
    ...(data ? { data } : {}),
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function visit(page: Page, route: string): Promise<void> {
  await page.evaluate(
    ({ basePath, route }) => {
      window.history.pushState({}, '', `${basePath}${route}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    },
    { basePath: E2E_BASE_PATH, route }
  );
}

test.beforeEach(async ({ page, request }) => {
  await control(request, '/upstream/start');
  await unlockDashboard(page);
});

test('finds real jobs without claiming them, restores saved filters and opens the source inspector', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const queue = `discovery-${testInfo.project.name}-${Date.now()}`;
  const correlationId = `invoice-${testInfo.project.name}`;
  const { id } = await native(request, `/queues/${queue}/jobs`, {
    name: 'native-discovery',
    data: { correlationId, privatePayload: 'payload-must-not-be-saved' },
    priority: 7,
    tags: ['native-search'],
  });
  await visit(page, '/search');
  await expect(page.getByRole('heading', { name: 'Global search', exact: true })).toBeVisible();
  await page.getByLabel('Queue', { exact: true }).fill(queue);
  await page.getByLabel('Search jobs', { exact: true }).fill(correlationId);
  const result = page.getByRole('row').filter({ hasText: id });
  await expect(result).toBeVisible();
  await expect(result.getByRole('cell', { name: queue, exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Scan complete' })).toBeVisible();
  expect((await native(request, `/queues/${queue}/counts`)).counts).toMatchObject({
    waiting: 0,
    prioritized: 1,
    active: 0,
  });

  await page.getByLabel('Saved view name').fill('Invoices');
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await page.getByLabel('Search jobs', { exact: true }).fill('no-such-observation');
  await expect(result).toHaveCount(0);
  await page.getByRole('button', { name: 'Invoices', exact: true }).click();
  await expect(result).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('Search jobs', { exact: true })).toHaveValue('no-such-observation');
  await expect(result).toHaveCount(0);
  await page.goForward();
  await expect(result).toBeVisible();
  const saved = await page.evaluate(() => JSON.stringify(localStorage));
  expect(saved).not.toContain(E2E_SERVER_TOKEN);
  expect(saved).not.toContain('payload-must-not-be-saved');
  await expectAccessible(page, testInfo, 'native-search');

  await page.reload();
  const auth = page.getByRole('dialog', { name: 'Authentication required' });
  await expect(auth).toBeVisible();
  await auth.getByLabel('Bearer token').fill(E2E_SERVER_TOKEN);
  await auth.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(auth).toBeHidden();
  await expect(page.getByLabel('Search jobs', { exact: true })).toHaveValue(correlationId);
  await expect(result).toBeVisible();
  await result.getByRole('button', { name: `Inspect job ${id}` }).click();
  await expect(page.getByRole('heading', { name: 'Job Inspector', exact: true })).toBeVisible();
  await expect(page.getByLabel('Job ID', { exact: true })).toHaveValue(id);
  await expect(
    page.locator('#main').getByText('payload-must-not-be-saved', { exact: false })
  ).toBeVisible();
  expectNoBrowserErrors(browserErrors);
});

test('groups real terminal failures by error signature while preserving different numeric codes', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const queue = `discovery-failures-${testInfo.project.name}-${Date.now()}`;
  const ids: string[] = [];
  for (const [index, code] of [500, 500, 404].entries()) {
    const { id } = await native(request, `/queues/${queue}/jobs`, {
      name: `native-failure-${index}`,
      data: { evidence: 'native-terminal-failure' },
      maxAttempts: 1,
    });
    await native(request, `/queues/${queue}/jobs/pull-batch`, { count: 1 });
    await native(request, `/jobs/${id}/fail`, {
      error: `HTTP ${code} request ${crypto.randomUUID()}`,
      unrecoverable: true,
    });
    ids.push(id);
  }
  await visit(page, '/failures');
  await expect(
    page.getByRole('heading', { name: 'Failure diagnostics', exact: true })
  ).toBeVisible();
  await page.getByLabel('Queue', { exact: true }).fill(queue);
  await expect(page.getByRole('heading', { name: /2 observed · HTTP 500 request/u })).toBeVisible();
  await expect(page.getByRole('heading', { name: /1 observed · HTTP 404 request/u })).toBeVisible();
  for (const id of ids) {
    await expect(page.getByRole('button', { name: `Inspect job ${id}` })).toBeVisible();
  }
  await expectAccessible(page, testInfo, 'native-failures');
  expectNoBrowserErrors(browserErrors);
});
