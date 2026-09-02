import { chromium, type Locator, type Page } from 'playwright';

export type DashboardFleetNode = {
  name: string;
  serverUrl: string;
  agentUrl: string;
  serverToken: string;
  agentToken: string;
};

export type DashboardFleetScenarioOptions = {
  dashboardUrl: string;
  postgresTarget: string;
  namespace: string;
  nodes: readonly DashboardFleetNode[];
};

export async function runPostgresFleetDashboardBrowserScenario(
  options: DashboardFleetScenarioOptions
): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ colorScheme: 'dark', locale: 'en-US' });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(20_000);
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('console', (entry) => {
    if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:')) {
      browserErrors.push(`console.error: ${entry.text()}`);
    }
  });

  try {
    await runScenario(page, options);
    if (browserErrors.length > 0) throw new Error(browserErrors.join('\n'));
    console.log('PASS browser console: no unexpected page or console errors');
  } finally {
    await browser.close();
  }
}

async function runScenario(page: Page, options: DashboardFleetScenarioOptions): Promise<void> {
  const runId = Date.now();
  const queueName = `orders-ui-${runId}`;
  const customJobId = `ui-cross-node-${runId}`;
  const cronName = `dashboard-realistic-cron-${runId}`;

  await page.goto(`${options.dashboardUrl}/settings`);
  await heading(page, 'Settings');
  for (const [index, node] of options.nodes.entries()) {
    if (index > 0) await page.getByRole('button', { name: 'Add node' }).click();
    await page.getByLabel('Node name').fill(node.name);
    await page.getByLabel('Server URL').fill(node.serverUrl);
    await page.getByLabel('Control agent URL').fill(node.agentUrl);
    await page.getByRole('textbox', { name: 'Bearer token (optional)' }).fill(node.serverToken);
    await page.getByRole('textbox', { name: 'Agent token (optional)' }).fill(node.agentToken);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await visible(page.getByText('Saved ✓'), `${node.name} save receipt`);
    await page.getByRole('button', { name: 'Test connection' }).click();
    await visible(
      page.getByText(/Connected in .*bunqueue v2\.9\.2/u),
      `${node.name} server connection`
    );
    await page.getByRole('button', { name: 'Test agent' }).click();
    await visible(
      page.getByText(/Agent connected in .*server running · postgres/u),
      `${node.name} agent connection`
    );
    console.log(`PASS settings: ${node.name}`);
  }

  await nav(page, 'Fleet', 'Fleet');
  await visible(stat(page, 'Configured nodes', String(options.nodes.length)), 'configured nodes');
  await visible(
    stat(page, 'Healthy APIs', `${options.nodes.length}/${options.nodes.length}`),
    'healthy APIs'
  );
  await visible(stat(page, 'PostgreSQL clusters', '1'), 'one PostgreSQL cluster');
  await visible(page.getByText(options.postgresTarget).first(), 'shared PostgreSQL target');
  await visible(page.getByText(options.namespace).first(), 'shared PostgreSQL namespace');
  for (const node of options.nodes) {
    await visible(page.getByRole('heading', { name: node.name }), `${node.name} fleet card`);
  }
  console.log('PASS fleet: 3/3 brokers, one PostgreSQL topology');

  await activate(page, options.nodes[0].name);
  await nav(page, 'Add Job', 'Add Job');
  await page.getByRole('combobox', { name: 'Queue', exact: true }).fill(queueName);
  await page.getByLabel('Job name').fill('invoice.created');
  await page
    .getByLabel('Data (JSON)')
    .fill(JSON.stringify({ invoiceId: 'inv-browser', amount: 249.9, source: 'dashboard-ui' }));
  await page.getByLabel('Priority').fill('7');
  await page.getByLabel('Max attempts').fill('3');
  await page.getByLabel('Custom job ID').fill(customJobId);
  await page.getByRole('switch', { name: 'durable' }).check();
  await page.getByLabel('Tags').fill('invoice, browser-realistic');
  await page.getByLabel('Group ID').fill('tenant-42');
  await page.getByRole('button', { name: 'Add job' }).click();
  await visible(page.getByText(`Accepted job ID ${customJobId}`), 'job acceptance receipt');
  console.log(`PASS job: created through ${options.nodes[0].name}`);

  await activate(page, options.nodes[1].name);
  await nav(page, 'Jobs', 'Jobs Explorer');
  await visible(page.getByText(customJobId, { exact: true }), 'shared job');
  await page.getByRole('link', { name: `Inspect job ${customJobId}` }).click();
  await heading(page, 'Job Inspector');
  await visible(page.getByText('invoice.created', { exact: true }), 'job name');
  await visible(page.getByText(/dashboard-ui/u), 'job payload');
  console.log(`PASS job: inspected through ${options.nodes[1].name}`);

  await activate(page, options.nodes[2].name);
  await nav(page, 'Queue Control', 'Queue Control');
  await page.getByRole('combobox', { name: 'Queue', exact: true }).selectOption(queueName);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await visible(page.getByRole('button', { name: 'Resume', exact: true }), 'inline resume');

  await activate(page, options.nodes[0].name);
  await nav(page, 'Queues', 'Queues');
  const queueRow = page.getByRole('row').filter({ hasText: queueName });
  await visible(queueRow.getByText('Paused', { exact: true }), 'paused queue on another node');
  await queueRow.getByRole('button', { name: 'Resume queue' }).click();
  await activate(page, options.nodes[1].name);
  await visible(queueRow.getByText('Active', { exact: true }), 'resumed queue on a third node');
  console.log('PASS lifecycle: pause C -> observe/resume A -> observe B');

  await nav(page, 'Queue Control', 'Queue Control');
  await page.locator('input[name="rate-limit"]').fill('5');
  await page.locator('input[name="rate-duration"]').fill('60000');
  await confirm(page, () => page.getByRole('button', { name: 'Replace policy' }).first().click());
  await visible(page.getByText('5 / 60000 ms', { exact: true }), 'rate-limit readback');
  await page.locator('input[name="concurrency"]').fill('2');
  await confirm(page, () => page.getByRole('button', { name: 'Replace policy' }).nth(1).click());
  await visible(fact(page, 'Global concurrency', '2'), 'concurrency readback');
  await activate(page, options.nodes[2].name);
  await refreshUntilVisible(
    page,
    page.getByRole('button', { name: 'Refresh limits' }),
    page.getByText('5 / 60000 ms', { exact: true }),
    'shared rate limit'
  );
  await visible(fact(page, 'Global concurrency', '2'), 'shared concurrency');
  console.log('PASS limits: rate and concurrency shared B -> C');

  await activate(page, options.nodes[0].name);
  await nav(page, 'Cron Jobs', 'Cron Manager');
  await page.getByLabel('Name', { exact: true }).fill(cronName);
  await page.getByLabel('Queue', { exact: true }).fill(queueName);
  await page.getByLabel('Cron expression').fill('0 9 * * *');
  await confirm(page, () => page.getByRole('button', { name: 'Submit upsert' }).click());
  await visible(page.getByRole('row').filter({ hasText: cronName }), 'cron on creator node');
  await activate(page, options.nodes[1].name);
  await visible(page.getByRole('row').filter({ hasText: cronName }), 'cron on peer node');
  console.log('PASS cron: create A -> observe B');

  await nav(page, 'Fleet', 'Fleet');
  const nodeCard = page.getByRole('heading', { name: options.nodes[2].name }).locator('..').locator('..');
  await confirm(page, () => nodeCard.getByRole('button', { name: 'Stop', exact: true }).click());
  await visible(nodeCard.getByText('stopped', { exact: true }), 'third broker stopped');
  await visible(stat(page, 'Healthy APIs', '2/3'), 'fleet degraded to 2/3');
  await nodeCard.getByRole('button', { name: 'Start', exact: true }).click();
  await visible(nodeCard.getByText('running', { exact: true }), 'third broker restarted');
  await visible(stat(page, 'Healthy APIs', '3/3'), 'fleet restored to 3/3');
  console.log('PASS lifecycle: stop/start Broker 3 from Fleet');
}

const sidebar = (page: Page) => page.locator('#app-nav nav');

async function nav(page: Page, link: string, title: string): Promise<void> {
  await sidebar(page).getByRole('link', { name: link, exact: true }).click();
  await heading(page, title);
}

async function heading(page: Page, title: string): Promise<void> {
  await visible(page.getByRole('heading', { name: title, level: 1 }), `${title} page`);
}

async function activate(page: Page, name: string): Promise<void> {
  await page
    .locator('#app-nav')
    .getByRole('combobox', { name: 'Active Bunqueue node' })
    .selectOption({ label: name });
}

function stat(page: Page, label: string, value: string): Locator {
  return page.getByText(label, { exact: true }).locator('..').getByText(value, { exact: true });
}

function fact(page: Page, label: string, value: string): Locator {
  return page.getByText(label, { exact: true }).locator('..').getByText(value, { exact: true });
}

async function visible(locator: Locator, description: string): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout: 15_000 }).catch((error) => {
    throw new Error(`Timed out waiting for ${description}: ${String(error)}`);
  });
}

async function refreshUntilVisible(
  page: Page,
  refresh: Locator,
  target: Locator,
  description: string
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await refresh.click();
    if (await target.isVisible()) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timed out waiting for ${description} after repeated refreshes`);
}

async function confirm(page: Page, action: () => Promise<void>): Promise<void> {
  const dialogPromise = page.waitForEvent('dialog');
  const actionPromise = action();
  const dialog = await dialogPromise;
  if (dialog.type() !== 'confirm') throw new Error(`Expected confirm, received ${dialog.type()}`);
  await dialog.accept();
  await actionPromise;
}
