import { expect, expectNoBrowserErrors, test } from '../fixtures';

test('both Mermaid diagrams hydrate after SSR and render once after client navigation', async ({
  page,
  browserErrors,
}) => {
  for (const path of ['/architecture', '/guide/fleet']) {
    await page.goto(path, { waitUntil: 'networkidle' });
    const diagram = page.locator('.vp-doc .mermaid');
    await expect(diagram).toHaveCount(1);
    await expect(diagram.locator('svg')).toHaveCount(1);
    await expect(diagram.locator('svg')).toBeVisible();
    await expect(diagram.locator('svg text, svg .nodeLabel').first()).toBeVisible();
    await expect(diagram.getByRole('alert')).toHaveCount(0);
    // Trigger actual VitePress navigation and then browser-history hydration.
    await page
      .getByRole('navigation', { name: 'Sidebar Navigation' })
      .getByRole('link', { name: 'Database', exact: true })
      .click();
    await expect(page).toHaveURL(/\/guide\/database$/);
    await page.goBack({ waitUntil: 'networkidle' });
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.locator('.vp-doc .mermaid svg')).toHaveCount(1);
    await expect(page.locator('.vp-doc .mermaid svg')).toBeVisible();
  }
  expectNoBrowserErrors(browserErrors);
});
