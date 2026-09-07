import type { APIRequestContext, Page } from '@playwright/test';
import { E2E_APP_URL, E2E_SERVER_TOKEN } from '../config';
import { expect } from '../fixtures';

export { test, expect, unlockDashboard, expectNoBrowserErrors } from '../fixtures';

export async function visit(page: Page, route: string): Promise<void> {
  await page.locator(`#app-nav nav a[href="/e2e/dashboard${route}"]`).click();
  const expected = new URL(`${E2E_APP_URL}${route}`);
  await expect(page).toHaveURL(
    (actual) => actual.origin === expected.origin && actual.pathname === expected.pathname
  );
}

export async function api(request: APIRequestContext, path: string) {
  const response = await request.get(`${E2E_APP_URL}${path}`, {
    headers: { Authorization: `Bearer ${E2E_SERVER_TOKEN}` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const result = await response.json();
  expect(result?.ok, JSON.stringify(result)).not.toBe(false);
  return result;
}

export async function command(page: Page, path: string, action: () => Promise<unknown>) {
  const received = page.waitForResponse(
    (r) => new URL(r.url()).pathname.endsWith(path) && r.request().method() !== 'GET'
  );
  const [response] = await Promise.all([received, action()]);
  expect(response.ok(), await response.text()).toBe(true);
  const result = await response.json();
  expect(result?.ok, JSON.stringify(result)).not.toBe(false);
  return result;
}
