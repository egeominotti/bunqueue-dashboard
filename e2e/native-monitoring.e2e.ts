import { readFile } from 'node:fs/promises';
import { E2E_APP_URL, E2E_BASE_PATH, E2E_DASHBOARD_PORT, E2E_SERVER_TOKEN } from './config';
import {
  control,
  expect,
  expectAccessible,
  expectNoBrowserErrors,
  test,
  unlockDashboard,
} from './fixtures';

test('exports monitoring configuration for a real native Prometheus endpoint without credentials', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  await control(request, '/upstream/start');
  await unlockDashboard(page);
  const metrics = await request.get(`${E2E_APP_URL}/api/prometheus`, {
    headers: { Authorization: `Bearer ${E2E_SERVER_TOKEN}` },
  });
  expect(metrics.ok()).toBe(true);
  const exposition = await metrics.text();
  expect(exposition).toContain('# TYPE bunqueue_jobs_failed_total counter');
  expect(exposition).toContain('bunqueue_jobs_waiting');
  await page.locator(`#app-nav nav a[href="${E2E_BASE_PATH}/monitoring"]`).click();
  await expect(page.getByRole('heading', { name: 'Monitoring setup', exact: true })).toBeVisible();
  const url = page.getByLabel('Prometheus scrape URL', { exact: true });
  await expect(url).toHaveValue(`${E2E_APP_URL}/api/prometheus`);
  await page.getByLabel('Scrape job name', { exact: true }).fill('production-bunqueue');
  await page.getByLabel('Use bearer token file', { exact: true }).check();
  const scrapeDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download scrape config', exact: true }).click();
  const scrapePath = await (await scrapeDownload).path();
  if (!scrapePath) throw new Error('Scrape config download is unavailable');
  const scrape = await readFile(scrapePath, 'utf8');
  expect(scrape).toContain(`${E2E_BASE_PATH}/api/prometheus`);
  expect(scrape).toContain(`127.0.0.1:${E2E_DASHBOARD_PORT}`);
  expect(scrape).toContain('bearer_token_file');
  expect(scrape).not.toContain(E2E_SERVER_TOKEN);
  const rulesDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download alert rules', exact: true }).click();
  const rulesPath = await (await rulesDownload).path();
  if (!rulesPath) throw new Error('Alert rules download is unavailable');
  const rules = await readFile(rulesPath, 'utf8');
  expect(rules).toContain('production-bunqueue');
  expect(rules).toContain('bunqueue_jobs_waiting');
  expect(rules).not.toContain(E2E_SERVER_TOKEN);
  await expectAccessible(page, testInfo, 'native-monitoring');
  await url.fill('https://user:secret@example.test/prometheus');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Download scrape config', exact: true })
  ).toHaveCount(0);
  expectNoBrowserErrors(browserErrors);
});
