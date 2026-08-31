import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BackupRunnerPort } from '../agent/backup/runner';
import { ProcessManager } from '../agent/manager';
import { createFetchHandler, resolveServerControlTarget } from '../agent/server';
import type { ServerStatus } from '../src/lib/bqTypes';
import { StatusConsole } from '../src/pages/control/server/StatusConsole';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function externalTarget(overrides: Record<string, string | undefined> = {}) {
  return resolveServerControlTarget({
    BUNQUEUE_MANAGED: '0',
    BUNQUEUE_URL: 'http://127.0.0.1:6790/',
    ...overrides,
  });
}

describe('external Bunqueue server mode', () => {
  test('parses explicit managed/external values and validates the health target', () => {
    expect(resolveServerControlTarget({}).mode).toBe('managed');
    expect(resolveServerControlTarget({ BUNQUEUE_MANAGED: 'yes' }).mode).toBe('managed');
    expect(externalTarget()).toMatchObject({
      mode: 'external',
      url: 'http://127.0.0.1:6790',
    });
    expect(
      externalTarget({
        BUNQUEUE_URL: 'https://queue.example/internal/',
        BUNQUEUE_TOKEN: ' secret ',
      })
    ).toEqual({ mode: 'external', url: 'https://queue.example/internal', token: 'secret' });

    expect(() => resolveServerControlTarget({ BUNQUEUE_MANAGED: 'sometimes' })).toThrow(
      'BUNQUEUE_MANAGED'
    );
    for (const invalid of [
      'tcp://queue.example:6789',
      'https://user:secret@queue.example',
      'https://queue.example?token=x',
      '//queue.example',
    ]) {
      expect(() => externalTarget({ BUNQUEUE_URL: invalid }), invalid).toThrow('BUNQUEUE_URL');
    }
  });

  test('reports external health with server auth and never follows redirects', async () => {
    let request:
      | { url: string; authorization: string | null; redirect: RequestRedirect | undefined }
      | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      request = {
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
        redirect: init?.redirect,
      };
      return Promise.resolve(
        Response.json({ ok: true, status: 'healthy', version: '2.9.2', uptime: 10 })
      );
    }) as typeof fetch;

    const manager = new ProcessManager();
    const handle = createFetchHandler(manager, {
      allowedOrigins: [],
      controlTarget: externalTarget({ BUNQUEUE_TOKEN: 'server-secret' }),
    });
    try {
      const response = await handle(new Request('http://agent.test/control/status'));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        managementMode: 'external',
        status: 'stopped',
        healthy: true,
        reachable: true,
        externalUrl: 'http://127.0.0.1:6790',
        healthStatus: 200,
        version: '2.9.2',
        db: null,
      });
      expect(request).toEqual({
        url: 'http://127.0.0.1:6790/health',
        authorization: 'Bearer server-secret',
        redirect: 'error',
      });
    } finally {
      await handle.shutdown();
    }
  });

  test('distinguishes reachable degraded health from an unreachable broker', async () => {
    const manager = new ProcessManager();
    const handle = createFetchHandler(manager, {
      allowedOrigins: [],
      controlTarget: externalTarget(),
    });
    try {
      globalThis.fetch = (() =>
        Promise.resolve(
          Response.json({ ok: false, status: 'degraded', version: '2.9.2' }, { status: 503 })
        )) as typeof fetch;
      const degraded = await handle(new Request('http://agent.test/control/status'));
      expect(await degraded.json()).toMatchObject({
        reachable: true,
        healthy: false,
        healthStatus: 503,
        healthError: 'Health reported degraded (HTTP 503)',
      });

      globalThis.fetch = (() => Promise.reject(new Error('connection refused'))) as typeof fetch;
      const offline = await handle(new Request('http://agent.test/control/status'));
      expect(await offline.json()).toMatchObject({
        reachable: false,
        healthy: false,
        healthStatus: null,
        healthError: 'connection refused',
      });
    } finally {
      await handle.shutdown();
    }
  });

  test('fails every lifecycle/config mutation closed without spawning a child', async () => {
    const manager = new ProcessManager();
    const initial = manager.getStatus();
    const handle = createFetchHandler(manager, {
      allowedOrigins: [],
      controlTarget: externalTarget(),
    });
    try {
      const requests = [
        new Request('http://agent.test/control/start', { method: 'POST' }),
        new Request('http://agent.test/control/stop', { method: 'POST' }),
        new Request('http://agent.test/control/restart', { method: 'POST' }),
        new Request('http://agent.test/control/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command: 'should-not-run' }),
        }),
      ];
      for (const request of requests) {
        const response = await handle(request);
        expect(response.status).toBe(409);
        expect(((await response.json()) as { error: string }).error).toContain(
          'BUNQUEUE_MANAGED=0'
        );
      }
      expect(manager.getStatus()).toEqual(initial);
      expect(manager.getLogs()).toEqual([]);
    } finally {
      await handle.shutdown();
    }
  });

  test('rejects restore before reading its body or entering maintenance in external mode', async () => {
    const manager = new ProcessManager();
    const initial = manager.getStatus();
    const database = await manager.dbStats();
    let runnerCalls = 0;
    let pulls = 0;
    let cancels = 0;
    const backupRunner: BackupRunnerPort = {
      execute: async () => {
        runnerCalls += 1;
        return { success: true, message: 'must not run' };
      },
      close: async () => undefined,
    };
    const handle = createFetchHandler(
      manager,
      {
        allowedOrigins: [],
        controlTarget: externalTarget(),
        managedProxyPath: '/internal/queue/api',
        managedProxyUrl: 'http://127.0.0.1:6790',
      },
      undefined,
      backupRunner
    );
    try {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ key: 'backups/confirmed.db', database })
      );
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(bytes);
            controller.close();
          },
          cancel() {
            cancels += 1;
          },
        },
        { highWaterMark: 0 }
      );
      const request = new Request(
        'http://agent.test/backup/restore?target=%2Finternal%2Fqueue%2Fapi',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          duplex: 'half',
        } as RequestInit & { duplex: 'half' }
      );
      expect(request.bodyUsed).toBe(false);
      expect(pulls).toBe(0);

      const response = await handle(request);
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toContain('BUNQUEUE_MANAGED=0');
      expect(request.bodyUsed).toBe(false);
      expect(pulls).toBe(0);
      expect(cancels).toBe(0);
      expect(runnerCalls).toBe(0);
      expect(manager.getStatus()).toEqual(initial);
      expect(manager.getLogs()).toEqual([]);
    } finally {
      await handle.shutdown();
    }
  });

  test('renders an external health state without lifecycle controls', () => {
    const status: ServerStatus = {
      managementMode: 'external',
      status: 'stopped',
      generation: 0,
      pid: null,
      startedAt: null,
      exitCode: 1,
      healthy: true,
      reachable: true,
      externalUrl: 'http://127.0.0.1:6790',
      healthStatus: 200,
      version: '2.9.2',
      config: {
        command: 'bunx bunqueue@2.9.2 start',
        httpPort: 6790,
        tcpPort: 6789,
        dataPath: './data/bunq.db',
        extraEnv: {},
      },
      runningConfig: null,
    };
    const html = renderToStaticMarkup(
      <StatusConsole
        status={status}
        agentBase="/agent"
        transitioning={false}
        busy={null}
        onStart={() => {}}
        onStop={() => {}}
        onRestart={() => {}}
      />
    );
    expect(html).toContain('External');
    expect(html).toContain('healthy via http://127.0.0.1:6790/health');
    expect(html).toContain('managed elsewhere');
    expect(html).not.toContain('crashed · exit 1');
    expect(html).not.toContain('>Start<');
    expect(html).not.toContain('>Stop<');
    expect(html).not.toContain('>Restart<');
  });
});
