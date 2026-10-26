import { E2E_BASE_PATH } from './config';
import { control, expect, expectNoBrowserErrors, test, unlockDashboard } from './fixtures';

test('reports native history unavailable for a real broker without a paired managed agent', async ({
  page,
  request,
  browserErrors,
}) => {
  await control(request, '/upstream/start');
  await unlockDashboard(page);
  await page.locator(`#app-nav nav a[href="${E2E_BASE_PATH}/metrics/history"]`).click();
  await expect(page.locator('#app-nav [aria-current="page"]')).toHaveCount(1);
  await page.getByLabel('Queue name', { exact: true }).fill('unmanaged-history');
  await page.getByRole('button', { name: 'Load history', exact: true }).click();
  for (const metric of ['completed', 'failed']) {
    const region = page.getByRole('region', { name: `${metric} history`, exact: true });
    await expect(
      region.getByText('Observed window total: Unavailable', { exact: true })
    ).toBeVisible();
    await expect(
      region.getByText('History unavailable; check the paired agent and server', { exact: true })
    ).toBeVisible();
  }
  expectNoBrowserErrors(browserErrors);
});
