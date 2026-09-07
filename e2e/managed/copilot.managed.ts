import { E2E_APP_URL, E2E_SERVER_TOKEN } from '../config';
import { api, expect, expectNoBrowserErrors, test, unlockDashboard } from './helpers';
import { localModel } from './local-model';

test('verifies Copilot streaming and confirmed, declined and stopped mutations against real Bunqueue', async ({
  page,
  request,
  browserErrors,
}) => {
  const seed = await request.post(`${E2E_APP_URL}/api/queues/managed-copilot/jobs`, {
    headers: { Authorization: `Bearer ${E2E_SERVER_TOKEN}` },
    data: { data: { copilot: true } },
  });
  expect(seed.ok()).toBe(true);
  const provider = await localModel();
  try {
    await unlockDashboard(page);
    await page.getByRole('button', { name: 'Open Copilot' }).click();
    const panel = page.getByRole('dialog', { name: 'Copilot', exact: true });
    await panel.getByLabel('Provider', { exact: true }).selectOption('custom');
    await panel.getByLabel('Base URL', { exact: true }).fill(provider.url);
    await panel.getByLabel('Model', { exact: true }).fill('scripted-local');
    await panel.getByLabel('API key', { exact: true }).fill('test-only-local-key');
    await panel.getByLabel('Message to Copilot').fill('pause the test queue');
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    await panel.getByRole('button', { name: 'Decline', exact: true }).click();
    await expect(
      panel.getByText('Local tool verification completed.', { exact: true })
    ).toBeVisible();
    expect((await api(request, '/api/dashboard/queues/managed-copilot')).paused).toBe(false);
    await panel.getByLabel('Message to Copilot').fill('pause the test queue');
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    await panel.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect
      .poll(async () => (await api(request, '/api/dashboard/queues/managed-copilot')).paused)
      .toBe(true);
    await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await panel.getByLabel('Message to Copilot').fill('resume the test queue');
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0);
    expect((await api(request, '/api/dashboard/queues/managed-copilot')).paused).toBe(true);
    page.once('dialog', (dialog) => dialog.accept());
    await panel.getByRole('button', { name: 'Clear chat', exact: true }).click();
    await expect(
      panel.getByText('Local tool verification completed.', { exact: true })
    ).toHaveCount(0);
    await panel.getByLabel('Message to Copilot').fill('resume the test queue');
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    await panel.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(
      panel.getByText('Local tool verification completed.', { exact: true })
    ).toBeVisible();
    expect((await api(request, '/api/dashboard/queues/managed-copilot')).paused).toBe(false);
    expect(provider.requests()).toBeGreaterThanOrEqual(7);
    expectNoBrowserErrors(browserErrors);
  } finally {
    await provider.close();
  }
});
