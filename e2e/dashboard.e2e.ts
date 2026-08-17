import type { Dialog, Page } from '@playwright/test';
import { E2E_APP_URL, E2E_BASE_PATH, E2E_ORIGIN, E2E_SERVER_TOKEN } from './config';
import {
  control,
  expect,
  expectAccessible,
  expectNoBrowserErrors,
  openAuthentication,
  test,
  unlockDashboard,
} from './fixtures';

test.beforeEach(async ({ request }) => {
  await control(request, '/upstream/start');
});

test.afterEach(async ({ request }) => {
  await control(request, '/upstream/start');
});

test('authenticates, keeps every route under BASE_PATH, and navigates the full sidebar', async ({
  page,
  request,
  browserErrors,
}) => {
  await unlockDashboard(page, true);

  const outsideMount = await request.get(`${E2E_ORIGIN}/`);
  expect(outsideMount.status()).toBe(404);
  await expect(page).toHaveURL(`${E2E_APP_URL}/`);

  const assetUrls = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => new URL(url).pathname.includes('/assets/'))
  );
  expect(assetUrls.length).toBeGreaterThan(0);
  expect(
    assetUrls.every((url) => new URL(url).pathname.startsWith(`${E2E_BASE_PATH}/assets/`))
  ).toBe(true);

  const hrefs = await page
    .locator('#app-nav nav a')
    .evaluateAll((links) =>
      links.map((link) => link.getAttribute('href')).filter((href): href is string => href !== null)
    );
  expect(hrefs.length).toBeGreaterThan(20);
  expect(hrefs.every((href) => href.startsWith(E2E_BASE_PATH))).toBe(true);

  for (const href of [...new Set(hrefs)]) {
    await page.locator(`#app-nav nav a[href="${href}"]`).click();
    await expect(page).toHaveURL(`${E2E_ORIGIN}${href}`);
    await expect(page.locator('#main h1').first()).toBeVisible();
    await expect(page.getByText('This page does not exist.')).toHaveCount(0);
  }

  expectNoBrowserErrors(browserErrors);
});

test('reconnects the authenticated SSE stream after a real upstream restart', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  await unlockDashboard(page);
  await expect(page.getByText('Waiting for live activity…')).toBeVisible();
  const queue = `sse-${testInfo.project.name}-${testInfo.retry}`;

  try {
    await control(request, '/upstream/stop');
    await expect(
      page.getByText(/Event stream unavailable|Connecting to the event stream/u).first()
    ).toBeVisible();

    await control(request, '/upstream/start');
    await expect(page.getByText('Waiting for live activity…')).toBeVisible({ timeout: 20_000 });
    await control(request, '/jobs', { queue });
    await expect(page.getByText(queue, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  } finally {
    await control(request, '/upstream/start');
  }

  expectNoBrowserErrors(browserErrors);
});

test('requires confirmation before creating and deleting a real cron', async ({
  page,
  browserErrors,
}, testInfo) => {
  await unlockDashboard(page);
  await page.locator('#app-nav').getByRole('link', { name: 'Cron Jobs' }).click();
  await expect(page.getByRole('heading', { name: 'Cron Manager' })).toBeVisible();

  const cronName = `browser-e2e-${testInfo.project.name}-${testInfo.retry}`;
  const queueName = `cron-${testInfo.project.name}-${testInfo.retry}`;
  await page.getByLabel('Name', { exact: true }).fill(cronName);
  await page.getByLabel('Queue', { exact: true }).fill(queueName);
  await page.getByLabel('Cron expression').fill('0 9 * * *');

  const submit = page.getByRole('button', { name: 'Submit upsert' });
  await answerConfirmation(
    page,
    () => submit.click(),
    'dismiss',
    `Submit an upsert for cron "${cronName}"`
  );
  await expect(page.getByRole('row').filter({ hasText: cronName })).toHaveCount(0);

  const created = page.waitForResponse(
    (response) =>
      response.url() === `${E2E_APP_URL}/api/crons` && response.request().method() === 'POST'
  );
  await answerConfirmation(
    page,
    () => submit.click(),
    'accept',
    `Submit an upsert for cron "${cronName}"`
  );
  expect((await created).ok()).toBe(true);
  const row = page.getByRole('row').filter({ hasText: cronName });
  await expect(row).toBeVisible();

  const remove = row.getByRole('button', { name: `Delete cron ${cronName}` });
  await answerConfirmation(page, () => remove.click(), 'dismiss', `Delete cron "${cronName}"`);
  await expect(row).toBeVisible();

  const deleted = page.waitForResponse(
    (response) =>
      response.url() === `${E2E_APP_URL}/api/crons/${cronName}` &&
      response.request().method() === 'DELETE'
  );
  await answerConfirmation(page, () => remove.click(), 'accept', `Delete cron "${cronName}"`);
  expect((await deleted).ok()).toBe(true);
  await expect(row).toHaveCount(0);
  expectNoBrowserErrors(browserErrors);
});

test('has no automated WCAG A/AA violations in critical states', async ({
  page,
  browserErrors,
}, testInfo) => {
  await openAuthentication(page);
  await expectAccessible(page, testInfo, 'authentication');
  await page.getByLabel('Bearer token').fill(E2E_SERVER_TOKEN);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expectAccessible(page, testInfo, 'overview');

  const criticalRoutes = [
    ['Queues', 'Queues'],
    ['Cron Jobs', 'Cron Manager'],
    ['Settings', 'Settings'],
  ] as const;
  for (const [linkName, heading] of criticalRoutes) {
    await page.locator('#app-nav nav').getByRole('link', { name: linkName, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await expectAccessible(page, testInfo, linkName.toLowerCase().replaceAll(' ', '-'));
  }

  expectNoBrowserErrors(browserErrors);
});

async function answerConfirmation(
  page: Page,
  action: () => Promise<void>,
  answer: 'accept' | 'dismiss',
  expectedMessage: string
): Promise<void> {
  const dialogPromise = page.waitForEvent('dialog');
  const actionPromise = action();
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe('confirm');
  expect(dialog.message()).toContain(expectedMessage);
  await settleDialog(dialog, answer);
  await actionPromise;
}

async function settleDialog(dialog: Dialog, answer: 'accept' | 'dismiss'): Promise<void> {
  if (answer === 'accept') await dialog.accept();
  else await dialog.dismiss();
}
