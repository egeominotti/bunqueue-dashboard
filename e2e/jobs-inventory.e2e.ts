import { readFile } from 'node:fs/promises';
import { E2E_APP_URL, E2E_SEED_QUEUE, E2E_SERVER_TOKEN } from './config';
import { control, expect, expectNoBrowserErrors, test, unlockDashboard } from './fixtures';

test('exports the complete filtered inventory and restores the selected queue through browser history', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  await control(request, '/upstream/start');
  const queue = `inventory-${testInfo.project.name}-${testInfo.retry}`;
  const created = await request.post(`${E2E_APP_URL}/api/queues/${queue}/jobs/bulk`, {
    headers: { Authorization: `Bearer ${E2E_SERVER_TOKEN}` },
    data: {
      jobs: Array.from({ length: 135 }, (_, index) => ({
        name: index === 134 ? 'special-invoice' : 'standard-invoice',
        data: { index },
      })),
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  expect((await created.json()).ids).toHaveLength(135);
  await unlockDashboard(page);
  await page.locator('#app-nav nav a[href="/e2e/dashboard/jobs"]').click();
  await page.getByLabel('Queue', { exact: true }).selectOption(queue);
  await expect(page.locator('tbody tr')).toHaveCount(25);

  const firstSelection = page.locator('tbody tr').first().getByRole('checkbox');
  const firstSelectionLabel = await firstSelection.getAttribute('aria-label');
  await firstSelection.check();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: firstSelectionLabel! })).not.toBeChecked();

  const allDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all matching CSV' }).click();
  const all = await allDownload;
  const allCsv = await readFile((await all.path())!, 'utf8');
  expect(allCsv.split('\n')).toHaveLength(136);
  expect(allCsv).toContain('special-invoice');

  await page.getByLabel('Filter by job ID or name').fill('special-invoice');
  const filteredDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all matching CSV' }).click();
  const filtered = await filteredDownload;
  const filteredCsv = await readFile((await filtered.path())!, 'utf8');
  expect(filteredCsv.split('\n')).toHaveLength(2);
  expect(filteredCsv).toContain('special-invoice');

  await page.locator('#app-nav nav a[href="/e2e/dashboard/queues"]').click();
  await page.getByRole('link', { name: E2E_SEED_QUEUE, exact: true }).click();
  await page.locator('#main').getByRole('link', { name: 'Jobs', exact: true }).click();
  await expect(page.getByLabel('Queue', { exact: true })).toHaveValue(E2E_SEED_QUEUE);
  await page.goBack();
  await page.goBack();
  await page.goBack();
  await expect(page.getByLabel('Queue', { exact: true })).toHaveValue(queue);
  await expect(page).toHaveURL(new RegExp(`/jobs\\?queue=${queue}$`));

  await page.setViewportSize({ width: 390, height: 844 });
  const statistics = page.getByRole('button', { name: 'Show all 8 statistics' });
  await expect(statistics).toBeVisible();
  await statistics.click();
  await expect(page.getByRole('button', { name: 'Hide detailed statistics' })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await page.getByRole('button', { name: 'Hide detailed statistics' }).click();
  const table = page.getByRole('region', { name: 'Jobs table' });
  await table.scrollIntoViewIfNeeded();
  const inspect = page.getByRole('link', { name: /^Inspect job / }).first();
  const container = await table.boundingBox();
  const initial = await inspect.boundingBox();
  expect(container && initial).toBeTruthy();
  expect(initial!.x + initial!.width).toBeLessThanOrEqual(container!.x + container!.width);
  await table.evaluate((element) => {
    element.scrollLeft = 300;
  });
  const scrolled = await inspect.boundingBox();
  expect(Math.abs(scrolled!.x - initial!.x)).toBeLessThan(2);
  expect(initial!.width).toBeGreaterThanOrEqual(44);
  expectNoBrowserErrors(browserErrors);
});
