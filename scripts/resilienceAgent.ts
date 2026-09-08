/** Disposable instrumentation fixture; never shipped or exposed by production entrypoints. */
import { databaseProcessLoad } from '../agent/db/processWorker';
import { exportWorkerLoad } from '../agent/db/exportTimeout';
import { queryWorkerLoad, readWithTimeout } from '../agent/db/queryTimeout';
import { ProcessManager } from '../agent/manager';
import { createFetchHandler } from '../agent/server';
import { tokenOk } from '../agent/server/policy';
import { installAgentShutdown } from '../agent/shutdown';

const token = process.env.BQ_RESILIENCE_TOKEN;
if (!token) throw new Error('The resilience fixture needs a test token');
const manager = new ProcessManager();
const handle = createFetchHandler(manager, { allowedOrigins: [], token, requireTokenForAll: true });
const stopAccepting: Array<() => unknown | Promise<unknown>> = [];
installAgentShutdown(handle, { stopAccepting });
const server = Bun.serve({
  hostname: '127.0.0.1', port: Number(process.env.BQ_RESILIENCE_PORT),
  async fetch(request) {
    if (!tokenOk(request, token)) return new Response(null, { status: 401 });
    const path = new URL(request.url).pathname;
    if (path === '/__resilience/metrics') return Response.json({ ok: true,
      rss: process.memoryUsage.rss(), children: databaseProcessLoad(),
      // Darwin RSS includes MADV_FREE_REUSABLE pages already returned to the
      // kernel. Measure the live footprint for cross-platform leak budgets.
      footprint: Bun.unsafe.memoryFootprint() ?? process.memoryUsage.rss(),
      queries: queryWorkerLoad(), exports: exportWorkerLoad(),
    });
    if (path === '/__resilience/slow') {
      try {
        await readWithTimeout('dbQuery', [manager.getConfig().dataPath,
          'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n',
        ], request.signal, 150);
        return new Response('Unbounded query unexpectedly completed', { status: 500 });
      } catch (error) {
        return Response.json({ ok: false, error: (error as Error).message }, { status: 503 });
      }
    }
    return handle(request);
  },
});
stopAccepting.push(() => server.stop(true));
