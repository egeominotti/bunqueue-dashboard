import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { E2E_SERVER_TOKEN, E2E_TCP_PORT } from '../config';
import {
  api,
  command,
  expect,
  expectNoBrowserErrors,
  test,
  unlockDashboard,
  visit,
} from './helpers';

test('connects an actual MCP client over stdio and displays registered workers from the real TCP broker', async ({
  page,
  request,
  browserErrors,
}) => {
  const client = new Client({ name: 'dashboard-local-verification', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'bun',
    args: [resolve('node_modules/.bin/bunqueue-mcp')],
    env: {
      PATH: process.env.PATH ?? '',
      BUNQUEUE_MODE: 'tcp',
      BUNQUEUE_HOST: '127.0.0.1',
      BUNQUEUE_PORT: String(E2E_TCP_PORT),
      BUNQUEUE_TOKEN: E2E_SERVER_TOKEN,
    },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const resources = await client.listResources();
    const prompts = await client.listPrompts();
    console.log(
      `Live MCP inventory: ${tools.tools.length} tools, ${resources.resources.length} resources, ${prompts.prompts.length} prompts`
    );
    expect(tools.tools.some((tool) => tool.name === 'bunqueue_add_job')).toBe(true);
    const registered = await client.callTool({
      name: 'bunqueue_register_worker',
      arguments: { name: 'managed-mcp-worker', queues: ['managed-mcp'] },
    });
    expect(registered.isError).not.toBe(true);
    const workerResult = JSON.parse((registered.content as Array<{ text: string }>)[0].text);
    expect(workerResult.success).toBe(true);
    const liveWorkers = (await api(request, '/api/workers')).data.workers;
    const workerId = liveWorkers.find(
      (worker: { name: string }) => worker.name === 'managed-mcp-worker'
    ).id;
    expect(workerId).not.toBe('0');
    const heartbeat = await client.callTool({
      name: 'bunqueue_worker_heartbeat',
      arguments: { workerId },
    });
    expect(heartbeat.isError).not.toBe(true);
    expect(JSON.parse((heartbeat.content as Array<{ text: string }>)[0].text).success).toBe(true);
    await unlockDashboard(page);
    await visit(page, '/workers');
    await expect(
      page.locator('#main').getByText('managed-mcp-worker', { exact: true })
    ).toBeVisible();

    expect(
      (await api(request, '/api/workers')).data.workers.some(
        (worker: { id: string }) => worker.id === workerId
      )
    ).toBe(true);
    await visit(page, '/mcp');
    await expect(
      page.locator('#main').getByText(`${tools.tools.length} total`, { exact: true })
    ).toBeVisible();
    const stats = await client.readResource({ uri: 'bunqueue://stats' });
    expect(stats.contents.length).toBeGreaterThan(0);
    const prompt = await client.getPrompt({ name: 'bunqueue_health_report' });
    expect(prompt.messages.length).toBeGreaterThan(0);
    const removed = await client.callTool({
      name: 'bunqueue_unregister_worker',
      arguments: { workerId },
    });
    expect(removed.isError).not.toBe(true);
    expect(JSON.parse((removed.content as Array<{ text: string }>)[0].text).success).toBe(true);
    expect(
      (await api(request, '/api/workers')).data.workers.some(
        (worker: { id: string }) => worker.id === workerId
      )
    ).toBe(false);
    const staleRegistration = await client.callTool({
      name: 'bunqueue_register_worker',
      arguments: { name: 'managed-stale-worker', queues: ['managed-mcp'] },
    });
    expect(staleRegistration.isError).not.toBe(true);
    const staleId = (await api(request, '/api/workers')).data.workers.find(
      (worker: { name: string }) => worker.name === 'managed-stale-worker'
    ).id;
    await visit(page, '/workers');
    const removeStale = page.getByRole('button', {
      name: `Remove stale registry record for worker ${staleId}`,
      exact: true,
    });
    await expect(removeStale).toHaveCount(0);
    // A registry-only fixture has no consumer process and sends no heartbeat.
    // Let the real broker mark it stale; do not advance browser clocks or mock state.
    await expect(removeStale).toBeVisible({ timeout: 45_000 });
    page.once('dialog', (dialog) => dialog.accept());
    await command(page, `/workers/${staleId}`, () => removeStale.click());
    expect(
      (await api(request, '/api/workers')).data.workers.some(
        (worker: { id: string }) => worker.id === staleId
      )
    ).toBe(false);
    expectNoBrowserErrors(browserErrors);
  } finally {
    await client.close();
    await transport.close();
  }
});
