import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test as base,
  type APIRequestContext,
  type Page,
  type TestInfo,
} from '@playwright/test';
import {
  E2E_APP_URL,
  E2E_BASE_PATH,
  E2E_CONTROL_TOKEN,
  E2E_CONTROL_URL,
  E2E_SERVER_TOKEN,
} from './config';

type BrowserDiagnostics = {
  browserErrors: string[];
};

export const test = base.extend<BrowserDiagnostics>({
  browserErrors: async ({ page }, provide) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
        errors.push(`console.error: ${message.text()}`);
      }
    });
    page.on('response', (response) => {
      const pathname = new URL(response.url()).pathname;
      if (response.status() >= 400 && pathname.includes('/assets/')) {
        errors.push(`asset HTTP ${response.status()}: ${pathname}`);
      }
    });
    await provide(errors);
  },
});

export { expect };

export async function control(
  request: APIRequestContext,
  route: '/upstream/start' | '/upstream/stop' | '/jobs',
  data?: Record<string, unknown>
): Promise<void> {
  const response = await request.post(`${E2E_CONTROL_URL}${route}`, {
    headers: { Authorization: `Bearer ${E2E_CONTROL_TOKEN}` },
    ...(data ? { data } : {}),
  });
  expect(response.ok(), `${route} failed: ${await response.text()}`).toBe(true);
}

export async function openAuthentication(page: Page): Promise<void> {
  await page.goto(`${E2E_BASE_PATH}/`);
  const dialog = page.getByRole('dialog', { name: 'Authentication required' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Bearer token')).toBeFocused();
}

export async function unlockDashboard(page: Page, verifyRejection = false): Promise<void> {
  await openAuthentication(page);
  const dialog = page.getByRole('dialog', { name: 'Authentication required' });
  const input = dialog.getByLabel('Bearer token');
  if (verifyRejection) {
    const rejected = page.waitForResponse(
      (response) =>
        response.status() === 401 &&
        response.url().startsWith(`${E2E_APP_URL}/api`) &&
        response.request().headers().authorization === 'Bearer definitely-wrong'
    );
    await input.fill('definitely-wrong');
    await dialog.getByRole('button', { name: 'Unlock' }).click();
    await rejected;
    await expect(dialog).toBeVisible();
  }

  const accepted = page.waitForResponse(
    (response) =>
      response.ok() &&
      response.url() === `${E2E_APP_URL}/api/dashboard` &&
      response.request().headers().authorization === `Bearer ${E2E_SERVER_TOKEN}`
  );
  await input.fill(E2E_SERVER_TOKEN);
  await dialog.getByRole('button', { name: 'Unlock' }).click();
  await accepted;
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
}

export async function expectAccessible(
  page: Page,
  testInfo: TestInfo,
  label: string
): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  await testInfo.attach(`axe-${label}`, {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  const fingerprints = result.violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map((node) => node.target),
  }));
  expect(fingerprints, `Accessibility violations on ${label}`).toEqual([]);
}

export function expectNoBrowserErrors(errors: string[]): void {
  expect(errors, 'The production UI emitted browser errors').toEqual([]);
}
