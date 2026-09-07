import {
  api,
  command,
  expect,
  expectNoBrowserErrors,
  test,
  unlockDashboard,
  visit,
} from './helpers';

test('creates every FlowProducer graph from the UI and inspects real dependencies', async ({
  page,
  request,
  browserErrors,
}) => {
  await unlockDashboard(page);
  await visit(page, '/flows');
  await page.getByRole('button', { name: 'create', exact: true }).click();
  const step = (name: string) => ({
    name,
    queueName: `managed-flow-${name}`,
    data: { verified: true },
  });
  const definitions = {
    add: { flow: { ...step('parent'), children: [step('child')] } },
    addBulk: { flows: [step('bulk-a'), step('bulk-b')] },
    addChain: { steps: [step('chain-a'), step('chain-b')] },
    addBulkThen: { parallel: [step('parallel-a'), step('parallel-b')], final: step('final') },
    addTree: { root: { ...step('root'), children: [step('branch')] } },
  };
  let parentId = '';
  for (const [method, definition] of Object.entries(definitions)) {
    await page.getByLabel('FlowProducer method').selectOption(method);
    await page.getByLabel('Flow definition JSON').fill(JSON.stringify(definition));
    const result = await command(page, '/flows/create', () =>
      page.getByRole('button', { name: `Run ${method}`, exact: true }).click()
    );
    expect(result.ok).toBe(true);
    if (method === 'add') parentId = result.result.root.id;
  }
  expect((await api(request, `/api/jobs/${parentId}`)).job.data).toMatchObject({ verified: true });
  await page.getByRole('button', { name: 'Job methods', exact: true }).click();
  await page.getByLabel('Flow job ID').first().fill(parentId);
  await page.getByLabel('Flow queue name').first().fill('managed-flow-parent');
  for (const method of [
    'getState',
    'isWaiting',
    'isActive',
    'isDelayed',
    'isCompleted',
    'isFailed',
    'isWaitingChildren',
    'toJSON',
    'asJSON',
    'getDependencies',
    'getDependenciesCount',
    'getChildrenValues',
    'getFailedChildrenValues',
    'getIgnoredChildrenFailures',
  ]) {
    const received = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith(`/${method}`));
    await page.getByRole('button', { name: method, exact: true }).click();
    const response = await received;
    expect(response.ok(), await response.text()).toBe(true);
    await expect(page.getByRole('button', { name: method, exact: true })).toBeEnabled();
  }
  await page.getByLabel('Flow Job mutation', { exact: true }).selectOption('log');
  await page.getByLabel('Flow Job mutation JSON').fill('{"message":"real-flow-ui-log"}');
  page.once('dialog', (dialog) => dialog.accept());
  await command(page, `/flows/jobs/${parentId}/log`, () =>
    page.getByRole('button', { name: 'Apply mutation' }).click()
  );
  expectNoBrowserErrors(browserErrors);
});
