import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { dbExportCsv, exportWorkerLoad, MissingDbError, setExportWorkerFactory } from '../agent/db';
import { ProcessManager } from '../agent/manager';
import { createFetchHandler } from '../agent/server';

const ALLOWED = ['http://localhost:5273'];

function _put(
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
