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

test('edits delayed job scheduling, promotes it, adds and clears logs, and verifies safety gates', async ({
  page,
  request,
  browserErrors,
}) => {
  const created = await request.post(`${E2E_APP_URL}/api/queues/managed-job-actions/jobs`, {
    headers: { Authorization: `Bearer ${E2E_SERVER_TOKEN}` },
    data: {
      name: 'managed-actions',
      data: { marker: 'managed-action-payload' },
      delay: 120000,
      priority: 10,
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = await created.json();
  await unlockDashboard(page);
  await visit(page, '/job');
  await page.getByLabel('Job ID', { exact: true }).fill(String(id));
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await page.getByLabel('Set priority', { exact: true }).fill('3');
  await command(page, `/jobs/${id}/priority`, () =>
    page.getByRole('button', { name: 'Set', exact: true }).click()
  );
  expect((await api(request, `/api/jobs/${id}`)).job.priority).toBe(3);
  await page.getByLabel('Set delay (ms)', { exact: true }).fill('90000');
  await command(page, `/jobs/${id}/delay`, () =>
    page.getByRole('button', { name: 'Delay', exact: true }).click()
  );
  await page.getByLabel('Log message').fill('operator audit note');
  await page.getByLabel('Log level').selectOption('warn');
  await command(page, `/jobs/${id}/logs`, () =>
    page.getByRole('button', { name: 'Add', exact: true }).click()
  );
  await expect(page.locator('ol').getByText('operator audit note', { exact: false })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await command(page, `/jobs/${id}/logs`, () =>
    page.getByRole('button', { name: 'Clear logs', exact: true }).click()
  );
  await expect(page.getByText('No log lines recorded for this job.')).toBeVisible();
  await command(page, `/jobs/${id}/promote`, () =>
    page.getByRole('button', { name: 'Promote (run now)', exact: true }).click()
  );
  expect((await api(request, `/api/jobs/${id}`)).job.state).toBe('prioritized');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  expectNoBrowserErrors(browserErrors);
});

test('browses SQLite schema, filters and exports real rows, runs SQL and rejects writes', async ({
  page,
  request,
  browserErrors,
}) => {
  const seeded = await request.post(`${E2E_APP_URL}/api/queues/managed-database/jobs`, {
    headers: { Authorization: `Bearer ${E2E_SERVER_TOKEN}` },
    data: { name: 'managed-database-row', data: { database: true } },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  await unlockDashboard(page);
  await visit(page, '/database');
  await page.getByRole('button', { name: /^jobs\s+\d/ }).click();
  await page.getByRole('button', { name: 'schema', exact: true }).click();
  await expect(
    page.locator('#main').getByText('CREATE TABLE', { exact: false }).first()
  ).toBeVisible();
  await page.getByRole('button', { name: 'data', exact: true }).click();
  await page.getByLabel('Filter column').selectOption('queue');
  await page.getByLabel('Filter operator').selectOption('eq');
  await page.getByLabel('Filter value').fill('managed-database');
  await page.getByLabel('Filter value').press('Enter');
  await expect(page.getByRole('button', { name: 'Export table (1)', exact: true })).toBeEnabled();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export table (1)', exact: true }).click();
  const download = await downloaded;
  const stream = await download.createReadStream();
  let csv = '';
  for await (const chunk of stream!) csv += chunk.toString();
  expect(csv).toContain('managed-database-row');
  await page.getByLabel('SQL query').fill('SELECT 42 AS answer');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible();
  const before = await api(request, '/api/queues/managed-database/counts');
  await page.getByLabel('SQL query').fill('DELETE FROM jobs');
  const rejected = page.waitForResponse(
    (r) => r.url().includes('/db/query') && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  expect((await rejected).ok()).toBe(false);
  expect(await api(request, '/api/queues/managed-database/counts')).toEqual(before);
  expectNoBrowserErrors(browserErrors);
});
