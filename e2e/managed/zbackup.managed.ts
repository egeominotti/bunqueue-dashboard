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
import { startMinio } from './minio';

let minio: Awaited<ReturnType<typeof startMinio>>;
test.beforeAll(async () => {
  minio = await startMinio();
});
test.afterAll(async () => {
  if (minio) {
    console.log(minio.environment);
    try {
      console.log((await minio.logs()).stderr);
    } finally {
      await minio.cleanup();
    }
  }
});

test('configures local S3, creates a real backup, restores it with the server stopped and verifies data', async ({
  page,
  request,
  browserErrors,
}) => {
  test.setTimeout(120_000);
  await unlockDashboard(page);
  await visit(page, '/s3');
  await page.getByLabel('Endpoint', { exact: true }).fill('http://127.0.0.1:49390');
  await page.getByLabel('Region', { exact: true }).fill('us-east-1');
  await page.getByLabel('Bucket name', { exact: true }).fill('dashboard-backups');
  await page.getByLabel('Access key ID', { exact: true }).fill('dashboard-test');
  await page.getByLabel('Secret access key', { exact: true }).fill('dashboard-local-test-password');
  await page.getByLabel('Backup interval', { exact: true }).selectOption('24h');
  await page.getByLabel('Addressing style', { exact: true }).selectOption('path-style');
  page.once('dialog', (dialog) => dialog.accept());
  const configured = page.waitForResponse(
    (r) => r.url().includes('/backup/configure') && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Apply configuration', exact: true }).click();
  expect((await configured).ok()).toBe(true);
  await visit(page, '/server');
  page.once('dialog', (dialog) => dialog.accept());
  await command(page, '/control/restart', () =>
    page.getByRole('button', { name: 'Restart', exact: true }).click()
  );
  await expect.poll(async () => (await api(request, '/agent/control/status')).healthy).toBe(true);
  await visit(page, '/s3');
  page.once('dialog', (dialog) => dialog.accept());
  const backedUp = page.waitForResponse(
    (r) => r.url().includes('/backup') && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Backup now', exact: true }).click();
  const result = await backedUp;
  expect(result.ok(), await result.text()).toBe(true);
  await expect(page.getByRole('button', { name: 'Restore', exact: true }).first()).toBeDisabled();
  const before = await api(request, '/agent/db/tables');
  const sentinel = await request.post(`${E2E_APP_URL}/api/queues/after-backup-only/jobs`, {
    headers: { Authorization: `Bearer ${E2E_SERVER_TOKEN}` },
    data: { data: { mustDisappearAfterRestore: true } },
  });
  expect(sentinel.ok()).toBe(true);
  await visit(page, '/server');
  page.once('dialog', (dialog) => dialog.accept());
  await command(page, '/control/stop', () =>
    page.getByRole('button', { name: 'Stop', exact: true }).click()
  );
  await visit(page, '/s3');
  const restore = page.getByRole('button', { name: 'Restore', exact: true }).first();
  await expect(restore).toBeEnabled();
  page.once('dialog', (dialog) => dialog.accept('RESTORE'));
  const restored = page.waitForResponse(
    (r) => r.url().includes('/restore') && r.request().method() === 'POST'
  );
  await restore.click();
  const response = await restored;
  expect(response.ok(), await response.text()).toBe(true);
  expect(await api(request, '/agent/db/tables')).toEqual(before);
  await visit(page, '/server');
  await command(page, '/control/start', () =>
    page.getByRole('button', { name: 'Start', exact: true }).click()
  );
  await expect.poll(async () => (await api(request, '/agent/control/status')).healthy).toBe(true);
  expect((await api(request, '/api/queues/after-backup-only/counts')).counts.waiting).toBe(0);
  expectNoBrowserErrors(browserErrors);
});
