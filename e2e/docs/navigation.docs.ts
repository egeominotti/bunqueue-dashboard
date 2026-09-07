import { readdir } from 'node:fs/promises';
import { expect, expectNoBrowserErrors, test } from '../fixtures';

const pages = (await readdir('docs/.vitepress/dist', { recursive: true }))
  .filter((path) => path.endsWith('.html') && path !== '404.html')
  .map((path) =>
    `/${path.replace(/(?:^|\/)index\.html$/, '/').replace(/\.html$/, '')}`.replace(/\/+/g, '/')
  );

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`direct clean URLs survive hydration at ${viewport.width}px`, async ({
    page,
    browserErrors,
  }) => {
    await page.setViewportSize(viewport);
    expect(pages.length).toBeGreaterThan(40);
    for (const path of pages) {
      await test.step(path, async () => {
        const response = await page.goto(path, { waitUntil: 'networkidle' });
        expect(response?.ok(), path).toBe(true);
        await expect(page).not.toHaveTitle(/^404/);
        await expect(page.locator('h1')).toBeVisible();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          `${path} overflows the document`
        ).toBe(true);
      });
    }
    expectNoBrowserErrors(browserErrors);
  });
}

test('search and in-app navigation resolve the new guide and preserve browser history', async ({
  page,
  browserErrors,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Search/ }).click();
  await page.getByRole('searchbox').fill('Bulk Add Jobs');
  await page
    .getByRole('link', { name: /Bulk Add Jobs/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/guide\/bulk-add(?:#.*)?$/);
  await expect(page.getByRole('heading', { level: 1, name: /^Bulk Add Jobs/ })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Sidebar Navigation' })
    .getByRole('link', { name: 'Database', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: /^Database/ })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: /^Bulk Add Jobs/ })).toBeVisible();
  expectNoBrowserErrors(browserErrors);
});
