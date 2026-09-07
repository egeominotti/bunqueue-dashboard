import { command, expect, expectNoBrowserErrors, test, unlockDashboard, visit } from './helpers';

test('loads real heap statistics, compacts memory and displays independent health probes', async ({
  page,
  browserErrors,
}) => {
  await unlockDashboard(page);
  await visit(page, '/diagnostics');
  await expect(page.getByText('Persistence accepts traffic', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'JSON metrics', exact: true })).toBeVisible();
  await command(page, '/gc', () =>
    page.getByRole('button', { name: 'Compact (GC)', exact: true }).click()
  );
  await expect(page.getByText(/No memory reclaimed|Freed .* MB/).first()).toBeVisible();
  const heap = page.waitForResponse(
    (response) => response.url().includes('/heap') && response.request().method() === 'GET'
  );
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  const response = await heap;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(page.getByText('Top object types', { exact: true })).toBeVisible();
  expectNoBrowserErrors(browserErrors);
});
