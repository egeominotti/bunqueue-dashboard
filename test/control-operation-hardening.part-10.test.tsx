import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import type { ServerTargetClient } from '../src/lib/bq';
import type { ServerStatus } from '../src/lib/bqTypes';
import { createBenchmarkCompensationQueue } from '../src/pages/control/benchmark/compensationQueue';
import { DEFAULT_CONFIG } from '../src/pages/control/benchmark/engine';
import { type BenchmarkLoopContext, createConsumer } from '../src/pages/control/benchmark/runLoops';
import { freshBenchmarkStats } from '../src/pages/control/benchmark/runtimeState';
import { ServerControl } from '../src/pages/control/ServerControl';
import { ensureDom, settle } from './domSetup';

ensureDom();

const realFetch = globalThis.fetch;
const realConfirm = globalThis.window.confirm;
const mounted = new Set<() => void>();

beforeEach(() => {
  useConnectionStore.setState({
    baseUrl: 'http://server-a.test',
    token: 'server-a-token',
    agentToken: 'agent-a-token',
    refreshMs: 60_000,
  });
});

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
  globalThis.fetch = realFetch;
  globalThis.window.confirm = realConfirm;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3000 });
});

describe('late lifecycle failures', () => {
  test('heartbeat rejection after Stop restores ownership before ACK', async () => {
    const heartbeat = deferred<{ ok: boolean; data: { ok: boolean; count: number } }>();
    const heartbeatEntered = deferred<void>();
    const ownJobIds = new Set(['job-1']);
    const stats = freshBenchmarkStats();
    let running = true;
    let acknowledgements = 0;
    let retries = 0;
    const client = {
      pullBatch: async () => ({ ok: true, jobs: [{ id: 'job-1' }], tokens: ['lock-1'] }),
      heartbeatBatch: () => {
        heartbeatEntered.resolve();
        return heartbeat.promise;
      },
      ackBatch: async () => {
        acknowledgements += 1;
        return { ok: true };
      },
      retryJob: async () => {
        retries += 1;
        return { ok: true };
      },
    } as ServerTargetClient;
    const context: BenchmarkLoopContext = {
      batch: 1,
      blob: '',
      client,
      compensationQueue: createBenchmarkCompensationQueue(),
      deadline: Number.POSITIVE_INFINITY,
      isCurrent: () => true,
      ownJobIds,
      payload: 0,
      pendingPushes: new Set(),
      processMs: 0,
      producersDone: () => true,
      queue: 'benchmark',
      runId: 'run-1',
      runConfig: { ...DEFAULT_CONFIG, total: 1, batch: 1, workerBatch: 1 },
      shouldContinue: () => running,
      stats,
      stop: () => {
        running = false;
      },
      total: 1,
      workerBatch: 1,
    };

    const consumer = createConsumer(context)();
    await heartbeatEntered.promise;
    running = false;
    heartbeat.reject(new Error('heartbeat transport failed after Stop'));
    await consumer;

    expect(acknowledgements).toBe(0);
    expect(retries).toBe(1);
    expect(ownJobIds.size).toBe(0);
    expect(stats.ackFailed).toBe(1);
    expect(stats.error).toBe('heartbeat transport failed after Stop');
  });

  test('rejected ACK keeps ambiguous ownership and never retries the job', async () => {
    const acknowledgement = deferred<{ ok: boolean }>();
    const ackEntered = deferred<void>();
    const ownJobIds = new Set(['job-1']);
    const stats = freshBenchmarkStats();
    let running = true;
    let acknowledgements = 0;
    let retries = 0;
    const client = {
      pullBatch: async () => ({ ok: true, jobs: [{ id: 'job-1' }], tokens: ['lock-1'] }),
      heartbeatBatch: async () => ({ ok: true, data: { ok: true, count: 1 } }),
      ackBatch: () => {
        acknowledgements += 1;
        ackEntered.resolve();
        return acknowledgement.promise;
      },
      retryJob: async () => {
        retries += 1;
        return { ok: true };
      },
    } as ServerTargetClient;
    const context: BenchmarkLoopContext = {
      batch: 1,
      blob: '',
      client,
      compensationQueue: createBenchmarkCompensationQueue(),
      deadline: Number.POSITIVE_INFINITY,
      isCurrent: () => true,
      ownJobIds,
      payload: 0,
      pendingPushes: new Set(),
      processMs: 0,
      producersDone: () => true,
      queue: 'benchmark',
      runId: 'run-1',
      runConfig: { ...DEFAULT_CONFIG, total: 1, batch: 1, workerBatch: 1 },
      shouldContinue: () => running,
      stats,
      stop: () => {
        running = false;
      },
      total: 1,
      workerBatch: 1,
    };

    const consumer = createConsumer(context)();
    await ackEntered.promise;
    running = false;
    acknowledgement.reject(new Error('ACK response lost after dispatch'));
    await consumer;

    expect(acknowledgements).toBe(1);
    expect(retries).toBe(0);
    expect(ownJobIds).toEqual(new Set(['job-1']));
    expect(stats.ackFailed).toBe(1);
    expect(stats.error).toBe('ACK response lost after dispatch');
  });

  test('pending restart keeps the global lifecycle lock across unmount and remount', async () => {
    const firstRestart = deferred<Response>();
    let restarts = 0;
    globalThis.window.confirm = () => true;
    globalThis.fetch = (async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/control/restart') {
        restarts += 1;
        return restarts === 1 ? firstRestart.promise : Response.json(serverStatus());
      }
      if (path === '/control/status') return Response.json(serverStatus());
      if (path === '/control/logs') return Response.json({ lines: [] });
      if (path === '/health') {
        return Response.json({
          ok: true,
          memory: { rss: 1, heapUsed: 1, heapTotal: 1 },
          connections: { tcp: 0, ws: 0, sse: 0 },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;

    const first = renderServer();
    await settle(15);
    clickRestart(first.host);
    expect(restarts).toBe(1);
    first.unmount();

    const replacement = renderServer();
    await settle(15);
    clickRestart(replacement.host);
    expect(restarts).toBe(1);

    firstRestart.resolve(Response.json(serverStatus()));
    await settle(15);
    clickRestart(replacement.host);
    await settle(10);
    expect(restarts).toBe(2);
    replacement.unmount();
  });
});

function serverStatus(): ServerStatus {
  const config = {
    command: 'bunqueue start',
    httpPort: 6790,
    tcpPort: 6789,
    dataPath: './data/a.db',
    extraEnv: {},
  };
  return {
    status: 'running',
    generation: 1,
    configRevision: 1,
    pid: 123,
    startedAt: 1,
    exitCode: null,
    healthy: true,
    config,
    runningConfig: config,
    db: null,
  };
}

function renderServer(): { host: HTMLElement; unmount: () => void } {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let active = true;
  const unmount = () => {
    if (!active) return;
    active = false;
    act(() => root.unmount());
    host.remove();
    mounted.delete(unmount);
  };
  mounted.add(unmount);
  act(() => root.render(createElement(ServerControl)));
  return { host, unmount };
}

function clickRestart(host: ParentNode): void {
  const control = [...host.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Restart'
  );
  if (!control) throw new Error('Missing Restart button');
  act(() => control.click());
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}
