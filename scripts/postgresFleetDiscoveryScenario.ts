import { expect, type Page } from '@playwright/test';
import type { DashboardFleetNode } from './postgresFleetDashboardBrowserScenario';

export async function verifyFleetDiscovery(
  page: Page,
  queue: string,
  jobId: string,
  nodes: readonly DashboardFleetNode[]
): Promise<void> {
  const active = page.getByRole('combobox', { name: 'Active Bunqueue node' });
  const original = await active.inputValue();
  await page.locator('#app-nav nav').getByRole('link', { name: 'Global search', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Global search', level: 1 })).toBeVisible();
  await page.getByLabel('Queue', { exact: true }).fill(queue);
  await page.getByLabel('Search jobs', { exact: true }).fill(jobId);
  const rows = page.getByRole('row').filter({
    has: page.getByRole('button', { name: `Inspect job ${jobId}`, exact: true }),
  });
  await expect(rows).toHaveCount(nodes.length);
  await expect(page.getByRole('status').filter({ hasText: 'Scan complete' })).toBeVisible();
  await expect(active).toHaveValue(original);
  for (const node of nodes) {
    await expect(rows.getByRole('cell', { name: node.name, exact: true })).toBeVisible();
  }
  await rows
    .filter({ has: page.getByRole('cell', { name: nodes[1].name, exact: true }) })
    .getByRole('button', { name: `Inspect job ${jobId}`, exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Job Inspector', level: 1 })).toBeVisible();
  await expect(active.locator('option:checked')).toHaveText(nodes[1].name);
  await expect(page.getByLabel('Job ID', { exact: true })).toHaveValue(jobId);
  console.log('PASS global discovery: three real credential-isolated brokers and source inspector');
}
