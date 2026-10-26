import { E2E_APP_URL, E2E_SERVER_TOKEN } from '../config';
import { expectAccessible } from '../fixtures';
import { api, expect, expectNoBrowserErrors, test, unlockDashboard, visit } from './helpers';

test('renders real native completion and terminal failure buckets for every history window', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const queue = `history-browser-${Date.now()}`;
  const headers = { Authorization: `Bearer ${E2E_SERVER_TOKEN}` };
  const write = async (path: string, data: Record<string, unknown>) => {
    const response = await request.post(`${E2E_APP_URL}/api${path}`, { headers, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const completed: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const { id } = await write(`/queues/${queue}/jobs`, {
      name: `native-history-${index}`,
      data: { metricEvidence: true },
      maxAttempts: 1,
    });
    await write(`/queues/${queue}/jobs/pull-batch`, { count: 1 });
    if (index < 2) {
      await write('/jobs/ack-batch', { ids: [id] });
      completed.push(id);
    } else {
      await write(`/jobs/${id}/fail`, {
        error: 'native-history-terminal-failure',
        unrecoverable: true,
      });
    }
  }
  expect(completed).toHaveLength(2);
  expect((await api(request, `/api/queues/${queue}/counts`)).counts).toMatchObject({
    completed: 2,
    failed: 1,
  });
  await unlockDashboard(page);
  await visit(page, '/metrics/history');
  await page.getByLabel('Queue name', { exact: true }).fill(queue);
  await page.getByRole('button', { name: 'Load history', exact: true }).click();
  const completedHistory = page.getByRole('region', { name: 'completed history', exact: true });
  const failedHistory = page.getByRole('region', { name: 'failed history', exact: true });
  for (const [window, end] of [
    ['1h', '59'],
    ['24h', '1439'],
    ['7d', '10079'],
  ] as const) {
    if (window !== '1h') {
      const response = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname.endsWith(`/queue-operations/${queue}/metrics`) &&
          url.searchParams.get('end') === end &&
          url.searchParams.get('type') === 'completed'
        );
      });
      await page.getByRole('button', { name: window, exact: true }).click();
      expect((await response).ok()).toBe(true);
    }
    await expect(
      completedHistory.getByText('Observed window total: 2', { exact: true })
    ).toBeVisible();
    await expect(
      failedHistory.getByText('Observed window total: 1', { exact: true })
    ).toBeVisible();
    await expect(completedHistory.getByText(/Known coverage: [12] \/ /u)).toBeVisible();
  }
  await expect(page.getByRole('img', { name: /Timestamp-aligned one-minute/u })).toBeVisible();
  await expectAccessible(page, testInfo, 'native-history');
  expectNoBrowserErrors(browserErrors);
});
