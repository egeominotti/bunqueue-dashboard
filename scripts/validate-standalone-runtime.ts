import type { StatusSnapshot } from '../agent/manager';
import type { DbQueryResult } from '../agent/db';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serialize } from 'node:v8';
import { freePort } from './flowRuntimeSupport';
import { waitForPackageResponse } from './validate-package-targets';

const argument = process.argv[2];
if (!argument) throw new Error('Usage: bun scripts/validate-standalone-runtime.ts <native-binary|--source>');
const command = argument === '--source'
  ? [process.execPath, resolve(import.meta.dir, 'serve.ts')]
  : [resolve(argument)];
const scratch = await mkdtemp(join(tmpdir(), 'bq-native-smoke-'));
const configPath = join(scratch, 'private/config.json');
const databasePath = join(scratch, 'store.db');
const token = 'native-smoke-agent-token';
const apiToken = 'native-smoke-api-token';
const base = '/native-smoke';
const upstream = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  fetch: (request) => Response.json({ ok: true, path: new URL(request.url).pathname }),
});
let runtime: ReturnType<typeof Bun.spawn> | undefined;
let outputs: Promise<string>[] = [];
let checks = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  checks++;
}

async function stop(): Promise<void> {
  if (!runtime || runtime.exitCode !== null) return;
  runtime.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const code = await Promise.race([
    runtime.exited,
    new Promise<null>((done) => { timer = setTimeout(() => done(null), 10_000); }),
  ]);
  clearTimeout(timer);
  if (code === null) {
    runtime.kill('SIGKILL');
    await runtime.exited;
    throw new Error('Standalone shutdown did not finish within 10s');
  }
  // Windows terminates with TerminateProcess; POSIX exercises installed signal handlers.
  if (process.platform !== 'win32') assert(code === 0, `Standalone shutdown failed (${code})`);
}

async function launch(): Promise<string> {
  const port = await freePort();
  const agentPort = await freePort();
  const child = Bun.spawn(command, {
    cwd: scratch,
    env: {
      // An empty PATH proves compiled SQLite reads do not require an installed Bun.
      PATH: join(scratch, 'empty-bin'), SystemRoot: process.env.SystemRoot,
      TEMP: scratch, TMPDIR: scratch,
      PORT: String(port), AGENT_PORT: String(agentPort), BIND_ADDR: '127.0.0.1',
      AGENT_CONFIG_PATH: configPath, BUNQUEUE_DATA_PATH: databasePath,
      AGENT_TOKEN: token, BUNQUEUE_TOKEN: apiToken, TRUST_PROXY: '1',
      BASE_PATH: base, BUNQUEUE_URL: `http://127.0.0.1:${upstream.port}`,
    },
    stdout: 'pipe', stderr: 'pipe',
  });
  runtime = child;
  outputs.push(new Response(child.stdout).text(), new Response(child.stderr).text());
  const url = `http://127.0.0.1:${port}${base}`;
  await waitForPackageResponse(`${url}/`, runtime);
  return url;
}

async function request(url: string, path: string, init: RequestInit = {}, bearer = token): Promise<Response> {
  return fetch(`${url}${path}`, {
    ...init, headers: { Authorization: `Bearer ${bearer}`, ...init.headers },
    signal: AbortSignal.timeout(20_000),
  });
}

async function verifyParentDisconnect(): Promise<void> {
  const input = serialize({ operation: 'dbQuery', args: [databasePath,
    'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n',
  ] });
  const ready = Promise.withResolvers<void>();
  const child = Bun.spawn([...command, '--bq-db-read'], {
    cwd: scratch,
    env: { PATH: join(scratch, 'empty-bin'), SystemRoot: process.env.SystemRoot, TEMP: scratch, TMPDIR: scratch },
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    ipc: (message, subprocess) => {
      if (message !== 'ready') return;
      try { subprocess.send(input); ready.resolve(); } catch (error) { ready.reject(error); }
    },
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    deadline = setTimeout(() => ready.reject(new Error('SQLite IPC readiness timed out')), 3000);
    await ready.promise;
    clearTimeout(deadline);
    await Bun.sleep(200);
    assert(child.exitCode === null, 'Isolated query exited before the disconnect test');
    child.disconnect();
    const code = await Promise.race([child.exited, new Promise<null>((done) => {
      deadline = setTimeout(() => done(null), 3000);
    })]);
    assert(code === 1, 'SQLite process survived the parent IPC disconnect');
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
  }
}

try {
  await mkdir(join(scratch, 'empty-bin'));
  const db = new Database(databasePath);
  db.run("CREATE TABLE jobs(id INTEGER PRIMARY KEY, data TEXT); INSERT INTO jobs VALUES(1,'native fixture')");
  db.close();
  let url = await launch();
  const page = await fetch(`${url}/`);
  const html = await page.text();
  assert(page.ok && html.includes('<div id="root"></div>'), 'Embedded application shell missing');
  assert(html.includes(`${base}/assets/`), 'BASE_PATH assets are not prefixed');
  assert(page.headers.get('x-content-type-options') === 'nosniff', 'Security headers missing');
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  assert(asset, 'Entry asset missing');
  assert((await fetch(new URL(asset, url))).ok, 'Embedded JavaScript is unavailable');
  assert((await fetch(`${url}/agent/control/status`)).status === 401, 'Remote agent accepted an unauthenticated read');
  assert((await fetch(`${url}/api/health`)).status === 401, 'API bridge accepted an unauthenticated read');
  assert((await request(url, '/api/health', {}, apiToken)).ok, 'Authenticated API proxy failed');

  const status = await (await request(url, '/agent/control/status')).json() as StatusSnapshot;
  assert(status.status === 'stopped', 'Standalone unexpectedly auto-started a server');
  const saved = await request(url, '/agent/control/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ extraEnv: { NATIVE_PERSISTENCE_CHECK: 'saved' } }),
  });
  assert(saved.ok, `Configuration save failed: ${await saved.text()}`);
  for (const path of ['/db/tables', '/db/info', '/db/tables/jobs', '/db/tables/jobs/schema', '/db/tables/jobs/cell?rowid=1&column=data', '/workflows', '/workflows/stats']) {
    const response = await request(url, `/agent${path}`);
    assert(response.ok, `${path} failed: ${await response.text()}`);
  }
  const query = await request(url, '/agent/db/query', { method: 'POST', body: JSON.stringify({ sql: 'SELECT 42 AS answer' }) });
  assert(query.ok && ((await query.json()) as DbQueryResult).rows[0]?.[0] === 42, 'Compiled SQLite query process failed');
  const csv = await request(url, '/agent/db/tables/jobs/export');
  assert(csv.ok && (await csv.text()).includes('native fixture'), 'Compiled CSV export process failed');
  const timeout = await request(url, '/agent/db/query', { method: 'POST', body: JSON.stringify({
    sql: 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n',
  }) });
  assert(timeout.status === 503 && (await timeout.text()).includes('time limit'), 'Runaway compiled query was not stopped');
  assert((await request(url, '/agent/db/tables')).ok, 'Timeout did not restore query capacity');
  await verifyParentDisconnect();
  await stop();
  url = await launch();
  const restarted = await (await request(url, '/agent/control/status')).json() as StatusSnapshot;
  assert(restarted.config.extraEnv.NATIVE_PERSISTENCE_CHECK === 'saved', 'Configuration was lost after agent restart');
  assert(restarted.configRevision !== status.configRevision, 'Revision reused across restart');
  assert(restarted.status === 'stopped', 'Restart auto-started managed server');
  await stop();
  console.log(JSON.stringify({ status: 'ok', platform: process.platform, arch: process.arch, bun: Bun.version, checks, source: argument === '--source' }));
} catch (error) {
  if (runtime?.exitCode === null) { runtime.kill('SIGKILL'); await runtime.exited; }
  console.error((await Promise.all(outputs)).join('\n'));
  throw error;
} finally {
  try { await stop(); } finally { upstream.stop(true); await rm(scratch, { recursive: true, force: true }); }
}
