import {
  api,
  command,
  expect,
  expectNoBrowserErrors,
  test,
  unlockDashboard,
  visit,
} from './helpers';

test('starts a registered workflow, sends a durable signal, archives and inspects its result', async ({
  page,
  request,
  browserErrors,
}) => {
  await unlockDashboard(page);
  await visit(page, '/workflows');
  await expect(page.getByText('Handlers loaded', { exact: true })).toBeVisible();
  await page.getByLabel('Registered workflow').fill('dashboard-approval-e2e');
  await page.getByLabel('Workflow input JSON').fill('{"value":21}');
  const started = await command(page, '/workflows/start', () =>
    page.getByRole('button', { name: 'Start execution', exact: true }).click()
  );
  const id = started.result.run.id as string;
  await visit(page, '/workflows/waiting');
  await page.getByRole('button', { name: id, exact: true }).click();
  await expect(page).toHaveURL((actual) => actual.searchParams.get('execution') === id);
  await page.getByLabel('Workflow signal event').fill('approved');
  await page.getByLabel('Workflow signal payload').fill('{"actor":"local-ui"}');
  page.once('dialog', (dialog) => dialog.accept());
  await command(page, `/workflows/${id}/signal`, () =>
    page.getByRole('button', { name: 'Send durable signal' }).click()
  );
  await expect
    .poll(async () => (await api(request, `/agent/workflows/${id}`)).execution?.state)
    .toBe('completed');
  await visit(page, '/workflows/archive');
  await page.getByLabel('Workflow retention age hours').fill('0');
  page.once('dialog', (dialog) => dialog.accept());
  await command(page, '/workflows/archive', () =>
    page.getByRole('button', { name: 'Archive eligible' }).click()
  );
  await page.getByRole('button', { name: id, exact: true }).click();
  await expect(page).toHaveURL((actual) => actual.searchParams.get('execution') === id);
  await expect(page.getByText('Signal persisted: approved', { exact: false })).toBeVisible();
  const archived = await api(request, `/agent/workflows/${id}?kind=archive`);
  expect(archived.execution.signals.approved).toEqual({ actor: 'local-ui' });
  expectNoBrowserErrors(browserErrors);
});

for (const decision of ['resume', 'abandon'] as const) {
  test(`executes ${decision} compensation through the managed workflow UI`, async ({
    page,
    request,
    browserErrors,
  }) => {
    await unlockDashboard(page);
    await visit(page, '/workflows');
    await page.getByLabel('Registered workflow').fill('dashboard-compensation-e2e');
    await page.getByLabel('Workflow input JSON').fill(JSON.stringify({ decision }));
    const started = await command(page, '/workflows/start', () =>
      page.getByRole('button', { name: 'Start execution', exact: true }).click()
    );
    const id = started.result.run.id as string;
    await visit(page, '/workflows/compensation');
    await page.getByRole('button', { name: id, exact: true }).click();
    await expect(page).toHaveURL((actual) => actual.searchParams.get('execution') === id);
    page.once('dialog', (dialog) => dialog.accept());
    await command(page, `/workflows/${id}/${decision}-compensation`, () =>
      page
        .getByRole('button', {
          name: decision === 'resume' ? 'Resume compensation' : 'Abandon remainder',
        })
        .click()
    );
    await expect
      .poll(async () => (await api(request, `/agent/workflows/${id}`)).execution.state)
      .toBe('failed');
    expect((await api(request, `/agent/workflows/${id}`)).execution.rollbackStatus).toBe(
      decision === 'resume' ? 'completed' : 'stuck'
    );
    expectNoBrowserErrors(browserErrors);
  });
}

test('reloads definitions, recovers orphans, filters executions and cleans only active terminal records', async ({
  page,
  request,
  browserErrors,
}) => {
  await unlockDashboard(page);
  await visit(page, '/workflows');
  await command(page, '/workflows/runtime/reload', () =>
    page.getByRole('button', { name: 'Reload definitions' }).click()
  );
  page.once('dialog', (dialog) => dialog.accept());
  await command(page, '/workflows/recover', () =>
    page.getByRole('button', { name: 'Recover orphaned' }).click()
  );
  await page.getByLabel('Registered workflow').fill('dashboard-instant-e2e');
  await page.getByLabel('Workflow input JSON').fill('{"value":73}');
  const started = await command(page, '/workflows/start', () =>
    page.getByRole('button', { name: 'Start execution', exact: true }).click()
  );
  const id = started.result.run.id as string;
  await expect
    .poll(async () => (await api(request, `/agent/workflows/${id}`)).execution.state)
    .toBe('completed');
  await visit(page, '/workflows/executions');
  await page.locator(`button:has([title="${id}"])`).click();
  await expect(page.getByRole('heading', { name: id })).toBeVisible();
  const archiveBefore = await api(request, '/agent/workflows?kind=archive');
  await visit(page, '/workflows/archive');
  await page.getByLabel('Workflow retention age hours').fill('0');
  page.once('dialog', (dialog) => dialog.accept());
  await command(page, '/workflows/cleanup', () =>
    page.getByRole('button', { name: 'Delete eligible' }).click()
  );
  expect((await api(request, '/agent/workflows?kind=archive')).total).toBe(archiveBefore.total);
  expect(
    (await api(request, '/agent/workflows')).executions.some((run: { id: string }) => run.id === id)
  ).toBe(false);
  expectNoBrowserErrors(browserErrors);
});
