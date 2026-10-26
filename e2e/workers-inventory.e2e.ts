import { E2E_APP_URL, E2E_BASE_PATH, E2E_SERVER_TOKEN } from './config';
import { control, expect, expectNoBrowserErrors, test, unlockDashboard } from './fixtures';

test('paginates and searches more than 300 real broker registry records', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  await control(request, '/upstream/start');
  const prefix = `inventory-${testInfo.project.name}-${testInfo.retry}`;
  const headers = { Authorization: `Bearer ${E2E_SERVER_TOKEN}` };
  const registered: string[] = [];
  try {
    for (let index = 0; index < 301; index++) {
      const id = `${prefix}-worker-${index}`;
      const response = await request.post(`${E2E_APP_URL}/api/workers`, {
        headers,
        data: {
          workerId: id,
          name: id,
          queues: [index === 250 ? `${prefix}-payments` : `${prefix}-orders`],
          concurrency: 1,
          hostname: 'synthetic-host',
          pid: index + 1,
        },
      });
      expect(response.ok(), await response.text()).toBe(true);
      expect((await response.json()).ok).toBe(true);
      registered.push(id);
    }
    const listing = await request.get(`${E2E_APP_URL}/api/workers`, { headers });
    expect(listing.ok()).toBe(true);
    const workers = (await listing.json()).data.workers as Array<{ id: string; name: string }>;
    expect(workers).toHaveLength(301);
    const workerOnSecondPage = workers[150].name;
    await unlockDashboard(page);
    await page.locator(`#app-nav a[href="${E2E_BASE_PATH}/workers"]`).click();
    await expect(page.locator('tbody tr')).toHaveCount(100);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: workerOnSecondPage })).toBeVisible();
    await page.getByLabel('Search workers').fill(`${prefix}-payments`);
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByRole('row').filter({ hasText: `${prefix}-worker-250` })).toBeVisible();
    expectNoBrowserErrors(browserErrors);
  } finally {
    for (const id of registered) {
      const response = await request.delete(
        `${E2E_APP_URL}/api/workers/${encodeURIComponent(id)}`,
        {
          headers,
        }
      );
      expect(response.ok(), `Could not clean up worker ${id}: ${await response.text()}`).toBe(true);
    }
  }
});
