import { Database } from 'bun:sqlite';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './flowRuntimeSupport';
import { waitForPackageResponse } from './validate-package-targets';

function positive(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
const seconds = positive('BQ_SOAK_SECONDS', 30, 21_600);
const rows = positive('BQ_SOAK_ROWS', 100_000, 10_000_000);
const scratch = await mkdtemp(join(tmpdir(), 'bq-resilience-'));
const path = join(scratch, 'large.db');
const port = await freePort();
const token = crypto.randomUUID();
const child = Bun.spawn([process.execPath, join(import.meta.dir, 'resilienceAgent.ts')], {
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: scratch, TMPDIR: scratch,
    BUNQUEUE_DATA_PATH: path, BQ_RESILIENCE_PORT: String(port), BQ_RESILIENCE_TOKEN: token },
  stdout: 'ignore', stderr: 'pipe',
});
const stderr = new Response(child.stderr).text();
const base = `http://127.0.0.1:${port}`;
const headers = { Authorization: `Bearer ${token}` };
let pendingRead: Promise<void> | undefined;
let cycles = 0;
let peakRss = 0;
let baselineRss = 0;
let baselineFootprint = 0;
let peakFootprint = 0;
let maxControlMs = 0;
const started = performance.now();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function get(route: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${route}`, { headers, signal: AbortSignal.timeout(10_000) });
  const body = await response.json() as Record<string, unknown>;
  assert(response.ok && body.ok !== false, `${route}: HTTP ${response.status}`);
  return body;
}

try {
  await (await waitForPackageResponse(`${base}/__resilience/metrics`, child, { headers })).arrayBuffer();
  const db = new Database(path);
  try {
    db.run('PRAGMA journal_mode=WAL');
    db.run('CREATE TABLE jobs(id INTEGER PRIMARY KEY, data TEXT)');
    db.query(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?)
      INSERT INTO jobs SELECT x, printf('%0256d', x) FROM n`).run(rows);
  } finally { db.close(); }
  const databaseBytes = (await stat(path)).size;
  do {
    const slow = pendingRead = fetch(`${base}/__resilience/slow`, { headers, signal: AbortSignal.timeout(10_000) }).then(async (response) => {
      assert(response.status === 503 && (await response.text()).includes('time limit'), 'Unbounded query did not time out');
    });
    const controlStarted = performance.now();
    await get('/control/status');
    maxControlMs = Math.max(maxControlMs, performance.now() - controlStarted);
    assert(maxControlMs < 1500, 'SQLite work stalled the agent event loop');
    await slow;
    const page = await get('/db/tables/jobs?limit=100&fcol=data&fop=contains&fval=1');
    assert(Number(page.total) > 0, 'Large-table scan did not return matching rows');
    await get('/db/tables/jobs/schema');
    const exported = await fetch(`${base}/db/tables/jobs/export`, { headers, signal: AbortSignal.timeout(20_000) });
    assert(exported.ok, `Export failed (${exported.status})`);
    const bytes = (await exported.arrayBuffer()).byteLength;
    assert(bytes > 0 && bytes <= 16 * 1024 * 1024, 'Export exceeded its bounded output contract');
    await configure(join(scratch, 'unavailable.db'));
    const missing = await fetch(`${base}/db/tables`, { headers });
    assert(missing.status === 404, 'Unavailable database did not fail closed');
    await missing.arrayBuffer();
    await configure(path);
    await get('/db/tables');
    const metrics = await get('/__resilience/metrics');
    assert(metrics.children === 0 && metrics.queries === 0 && metrics.exports === 0, 'A read process or pool slot leaked');
    cycles++;
    const footprint = Number(metrics.footprint);
    assert(Number.isFinite(footprint) && footprint > 0, 'Agent memory measurement is unavailable');
    if (cycles === 3) { baselineRss = Number(metrics.rss); baselineFootprint = footprint; }
    if (cycles >= 3) { peakRss = Math.max(peakRss, Number(metrics.rss)); peakFootprint = Math.max(peakFootprint, footprint); }
    if (cycles % 20 === 0) console.log(JSON.stringify({ progress: cycles, rssMiB: Math.round(peakRss / 1048576), footprintMiB: Math.round(peakFootprint / 1048576) }));
  } while (cycles < 5 || performance.now() - started < seconds * 1000);
  console.log(JSON.stringify({ baselineRss, peakRss, baselineFootprint, peakFootprint, growthMiB: Math.round((peakFootprint - baselineFootprint) / 1048576) }));
  assert(peakFootprint - baselineFootprint < 128 * 1024 * 1024, 'Agent memory footprint grew by more than 128 MiB after warmup');
  console.log(JSON.stringify({ status: 'ok', platform: process.platform, arch: process.arch, bun: Bun.version,
    seconds: Math.round((performance.now() - started) / 1000), rows, databaseBytes, cycles,
    baselineRss, peakRss, baselineFootprint, peakFootprint, maxControlMs: Math.round(maxControlMs), liveChildren: 0 }));
} finally {
  await pendingRead?.catch(() => undefined);
  child.kill('SIGTERM');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
  await child.exited;
  clearTimeout(deadline);
  const errors = await stderr;
  if (child.exitCode !== 0) console.error(errors);
  await rm(scratch, { recursive: true, force: true });
  assert(child.exitCode === 0, 'Resilience agent did not shut down cleanly');
}

async function configure(dataPath: string): Promise<void> {
  const response = await fetch(`${base}/control/config`, { method: 'PUT', headers,
    body: JSON.stringify({ dataPath }), signal: AbortSignal.timeout(5000) });
  assert(response.ok, `Configuration update failed (${response.status})`);
  await response.arrayBuffer();
}
