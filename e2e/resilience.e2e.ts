import { control, expect, expectNoBrowserErrors, test, unlockDashboard } from './fixtures';

test('resilience: repeatedly recovers authenticated live events after upstream restarts', async ({
  page,
  request,
  browserErrors,
}, testInfo) => {
  const cycles = Number(process.env.BQ_RECONNECT_CYCLES ?? 3);
  expect(Number.isSafeInteger(cycles) && cycles >= 1 && cycles <= 200).toBe(true);
  test.setTimeout(30_000 * (cycles + 1));
  await control(request, '/upstream/start');
  await unlockDashboard(page);
  const metrics: number[] = [];
  const session =
    testInfo.project.name === 'chromium' ? await page.context().newCDPSession(page) : undefined;
  try {
    for (let cycle = 0; cycle < cycles; cycle++) {
      await control(request, '/upstream/stop');
      await expect(
        page.getByText(/Event stream unavailable|Connecting to the event stream/u).first()
      ).toBeVisible();
      const reconnected = page.waitForResponse(
        (response) => response.url().includes('/api/events') && response.ok()
      );
      await control(request, '/upstream/start');
      await reconnected;
      const queue = `resilience-${testInfo.project.name}-${cycle}`;
      await control(request, '/jobs', { queue });
      await expect(page.getByText(queue, { exact: true }).first()).toBeVisible();
      if (session) metrics.push((await session.send('Runtime.getHeapUsage')).usedSize);
    }
    if (metrics.length > 1)
      expect(Math.max(...metrics) - metrics[0]!).toBeLessThan(64 * 1024 * 1024);
    await testInfo.attach('reconnection-soak', {
      body: JSON.stringify({ cycles, heapBytes: metrics }),
      contentType: 'application/json',
    });
    expectNoBrowserErrors(browserErrors);
  } finally {
    await session?.detach();
    await control(request, '/upstream/start');
  }
});
