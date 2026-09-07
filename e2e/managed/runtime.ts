import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  E2E_AGENT_PORT,
  E2E_APP_URL,
  E2E_BASE_PATH,
  E2E_CONTROL_PORT,
  E2E_DASHBOARD_PORT,
  E2E_HTTP_PORT,
  E2E_SERVER_TOKEN,
  E2E_TCP_PORT,
} from '../config';

let stopping = false;
let stop: () => void = () => {};
const stopped = new Promise<void>((resolve) => {
  stop = resolve;
});
const onSignal = () => {
  stopping = true;
  stop();
};
process.once('SIGTERM', onSignal);
process.once('SIGINT', onSignal);
const scratch = await mkdtemp(join(tmpdir(), 'bunqueue-managed-ui-'));
let ready = false;
let readiness: ReturnType<typeof Bun.serve> | undefined;
let dashboard: ReturnType<typeof Bun.spawn> | undefined;
try {
  readiness = Bun.serve({
    hostname: '127.0.0.1',
    port: E2E_CONTROL_PORT,
    fetch: () => Response.json({ ready }, { status: ready ? 200 : 503 }),
  });
  dashboard = Bun.spawn(['bun', 'scripts/serve.ts'], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      BIND_ADDR: '127.0.0.1',
      HOST: '127.0.0.1',
      PORT: String(E2E_DASHBOARD_PORT),
      AGENT_PORT: String(E2E_AGENT_PORT),
      HTTP_PORT: String(E2E_HTTP_PORT),
      TCP_PORT: String(E2E_TCP_PORT),
      BASE_PATH: E2E_BASE_PATH,
      BUNQUEUE_URL: `http://127.0.0.1:${E2E_HTTP_PORT}`,
      BUNQUEUE_DATA_PATH: join(scratch, 'bunqueue.db'),
      BUNQUEUE_START_CMD: 'bun node_modules/bunqueue/dist/cli/index.js start',
      BUNQUEUE_MANAGED: '1',
      BUNQUEUE_TOKEN: E2E_SERVER_TOKEN,
      AGENT_TOKEN: '',
      AGENT_ALLOWED_HOSTS: '',
      AGENT_ALLOWED_ORIGINS: '',
      TRUST_PROXY: '0',
    },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const deadline = Date.now() + 20_000;
  while (true) {
    if (stopping) throw new Error('Managed dashboard startup interrupted');
    if (dashboard.exitCode !== null) throw new Error('Managed dashboard exited during startup');
    try {
      if (
        (await fetch(`${E2E_APP_URL}/agent/control/status`, { signal: AbortSignal.timeout(1_000) }))
          .ok
      )
        break;
    } catch {
      // Wait for the disposable listener.
    }
    if (Date.now() > deadline) throw new Error('Managed dashboard readiness timed out');
    await Bun.sleep(50);
  }
  const config = await fetch(`${E2E_APP_URL}/agent/control/config`, {
    method: 'PUT',
    signal: AbortSignal.timeout(5_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      extraEnv: {
        HOST: '127.0.0.1',
        AUTH_TOKENS: E2E_SERVER_TOKEN,
        BUNQUEUE_WORKFLOW_MODULE: resolve('test/fixtures/workflow-runtime.ts'),
        BUNQUEUE_WORKFLOW_QUEUE_NAME: '__dashboard:managed-ui',
      },
    }),
  });
  if (!config.ok) throw new Error(await config.text());
  const started = await fetch(`${E2E_APP_URL}/agent/control/start`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
  });
  if (!started.ok) throw new Error(await started.text());
  const healthyDeadline = Date.now() + 20_000;
  while (true) {
    if (stopping || dashboard.exitCode !== null)
      throw new Error('Managed fixture stopped before broker readiness');
    const status = await fetch(`${E2E_APP_URL}/agent/control/status`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!status.ok) throw new Error(await status.text());
    const state = await status.json();
    if (state.healthy === true) break;
    if (state.status === 'stopped' || state.status === 'error' || Date.now() > healthyDeadline) {
      throw new Error(`Managed broker failed readiness: ${JSON.stringify(state)}`);
    }
    await Bun.sleep(100);
  }
  ready = true;
  await Promise.race([
    dashboard.exited.then((code) => {
      throw new Error(`Managed dashboard exited unexpectedly: ${code}`);
    }),
    stopped,
  ]);
} finally {
  process.removeListener('SIGTERM', onSignal);
  process.removeListener('SIGINT', onSignal);
  readiness?.stop(true);
  if (dashboard) {
    dashboard.kill('SIGTERM');
    await Promise.race([dashboard.exited, Bun.sleep(5_000)]);
    if (dashboard.exitCode === null) {
      dashboard.kill('SIGKILL');
      await dashboard.exited;
    }
  }
  await rm(scratch, { recursive: true, force: true });
}
