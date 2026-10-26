import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Engine } from 'bunqueue/workflow';
import { ProcessManager } from '../agent/manager';
import { createFetchHandler } from '../agent/server';
import { WorkflowRuntime } from '../agent/workflow/runtime';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe('Workflow reads and local agent credentials', () => {
  test('anonymous GET never imports handlers or creates, replaces, or closes an Engine', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-read-security-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const marker = join(directory, 'registered');
    const module = join(directory, 'runtime.ts');
    await Bun.write(
      module,
      `export async function registerWorkflowRuntime() {
      await Bun.write(${JSON.stringify(marker)}, 'initialized');
    }`
    );
    let creations = 0;
    let closures = 0;
    const engine = {
      close: async () => {
        closures++;
      },
      register: () => engine,
    };
    const runtime = new WorkflowRuntime(() => {
      creations++;
      return engine as unknown as Engine;
    });
    const manager = new ProcessManager();
    manager.setConfig({ extraEnv: { BUNQUEUE_WORKFLOW_MODULE: module } });
    let running = true;
    const actualStatus = manager.getStatus.bind(manager);
    manager.getStatus = () => ({ ...actualStatus(), status: running ? 'running' : 'stopped' });
    const handle = createFetchHandler(manager, { allowedOrigins: [], token: 'secret' }, runtime);
    cleanup.push(() => handle.close());
    const url = 'http://localhost/workflows/runtime?target=http://localhost:6790';
    const first = await handle(new Request(url));
    expect(first.status).toBe(200);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(creations).toBe(0);
    expect(await first.json()).toMatchObject({
      result: { ready: false, needsInitialization: true },
    });

    const initialize = url.replace('/runtime?', '/runtime/initialize?');
    expect((await handle(new Request(initialize, { method: 'POST' }))).status).toBe(401);
    expect(await Bun.file(marker).exists()).toBe(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await handle(
        new Request(initialize, {
          method: 'POST',
          headers: { Authorization: 'Bearer secret' },
        })
      );
      expect(response.status).toBe(200);
    }
    expect(await Bun.file(marker).text()).toBe('initialized');
    expect(creations).toBe(1);
    expect((await (await handle(new Request(url))).json()).result.ready).toBe(true);
    running = false;
    expect((await (await handle(new Request(url))).json()).result.ready).toBe(false);
    expect(closures).toBe(0);
    manager.setConfig({ extraEnv: {} });
    await handle(new Request(url));
    expect(closures).toBe(0);
  });

  test('configured local token protects complete config and status snapshots', async () => {
    const manager = new ProcessManager();
    manager.setConfig({
      extraEnv: { AUTH_TOKENS: 'broker-secret', S3_SECRET_ACCESS_KEY: 's3-secret' },
    });
    const handle = createFetchHandler(manager, { allowedOrigins: [], token: 'agent-secret' });
    cleanup.push(() => handle.close());
    for (const path of ['/control/config', '/control/status']) {
      const denied = await handle(new Request(`http://localhost${path}`));
      expect(denied.status).toBe(401);
      expect(await denied.text()).not.toContain('broker-secret');
      const authorized = await handle(
        new Request(`http://localhost${path}`, {
          headers: { 'X-Agent-Token': 'agent-secret' },
        })
      );
      expect(authorized.status).toBe(200);
      expect(await authorized.text()).toContain('broker-secret');
    }
    expect((await handle(new Request('http://localhost/control/logs'))).status).toBe(200);
  });

  test('local configuration remains accessible when no agent token is configured', async () => {
    const handle = createFetchHandler(new ProcessManager(), { allowedOrigins: [] });
    cleanup.push(() => handle.close());
    expect((await handle(new Request('http://localhost/control/config'))).status).toBe(200);
  });
});
