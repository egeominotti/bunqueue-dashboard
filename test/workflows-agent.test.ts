import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { Packr } from 'msgpackr';
import { MissingDbError } from '../agent/db';
import { ProcessManager } from '../agent/manager';
import { createFetchHandler } from '../agent/server';
import { workflowExecution, workflowExecutions, workflowStats } from '../agent/workflows';

const paths: string[] = [];
const packr = new Packr({ structuredClone: true });

function database() {
  const path = `/tmp/bunqueue-dashboard-workflow-${crypto.randomUUID()}.db`;
  paths.push(path);
  const db = new Database(path, { create: true });
  for (const [table, archived] of [
    ['workflow_executions', false],
    ['workflow_executions_archive', true],
  ] as const) {
    db.run(`CREATE TABLE ${table} (
      id TEXT PRIMARY KEY, workflow_name TEXT NOT NULL, state TEXT NOT NULL,
      input BLOB, steps BLOB, current_node_index INTEGER NOT NULL,
      resolved_steps BLOB, signals BLOB, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${archived ? ', archived_at INTEGER NOT NULL' : ''}, meta BLOB
    )`);
  }
  return { db, path };
}

function insert(
  db: Database,
  table: 'workflow_executions' | 'workflow_executions_archive',
  id: string
) {
  const archived = table.endsWith('_archive');
  db.query(
    `INSERT INTO ${table} (id, workflow_name, state, input, steps, current_node_index,
      resolved_steps, signals, created_at, updated_at${archived ? ', archived_at' : ''}, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?${archived ? ', ?' : ''}, ?)`
  ).run(
    id,
    'checkout',
    archived ? 'completed' : 'compensation-stuck',
    packr.pack({ orderId: 'ord_1' }),
    packr.pack({
      charge: {
        status: 'failed',
        attempts: 3,
        compensatable: true,
        compensation: { status: 'compensation-failed', at: 1800, error: 'offline' },
      },
    }),
    2,
    packr.pack(['charge']),
    packr.pack({ approved: { by: 'ops' } }),
    1000,
    2000,
    ...(archived ? [3000] : []),
    packr.pack({
      rollbackStatus: archived ? 'completed' : 'stuck',
      failureReason: archived ? undefined : 'refund unavailable',
      decisions: { route: 'card' },
      definitionHash: 'hash-v1',
      committedAt: 1,
    })
  );
}

afterEach(() => {
  for (const path of paths.splice(0)) {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

describe('Workflow Engine read-only adapter', () => {
  test('reports state totals and lists deterministic summaries with exact filters', () => {
    const { db, path } = database();
    insert(db, 'workflow_executions', 'wf-active');
    insert(db, 'workflow_executions', 'wf-compensating');
    db.query("UPDATE workflow_executions SET state = 'compensating' WHERE id = ?").run(
      'wf-compensating'
    );
    insert(db, 'workflow_executions_archive', 'wf-archived');
    db.close();

    const stats = workflowStats(path);
    expect(stats.available).toBe(true);
    expect(stats.activeTotal).toBe(2);
    expect(stats.archiveTotal).toBe(1);
    expect(stats.states['compensation-stuck']).toBe(1);
    expect(stats.workflowNames).toEqual(['checkout']);

    const page = workflowExecutions(path, {
      workflowName: 'checkout',
      state: 'compensation-stuck',
    });
    expect(page.total).toBe(1);
    expect(page.executions[0]).toMatchObject({
      id: 'wf-active',
      rollbackStatus: 'stuck',
      failureReason: 'refund unavailable',
      definitionHash: 'hash-v1',
    });
    expect(workflowExecutions(path, { workflowName: 'other' }).total).toBe(0);
    expect(workflowExecutions(path, { state: 'compensation' }).total).toBe(2);
  });

  test('reads page rows and total from one snapshot while a WAL writer commits', () => {
    const { db, path } = database();
    db.run('PRAGMA journal_mode = WAL');
    insert(db, 'workflow_executions', 'wf-before');

    const page = workflowExecutions(path, {}, () => {
      insert(db, 'workflow_executions', 'wf-during-read');
    });

    expect(page.executions.map((execution) => execution.id)).toEqual(['wf-before']);
    expect(page.total).toBe(1);
    expect(
      (db.query('SELECT COUNT(*) AS count FROM workflow_executions').get() as { count: number })
        .count
    ).toBe(2);
    db.close();
  });

  test('reads active and archive stats from one snapshot while archival commits', () => {
    const { db, path } = database();
    db.run('PRAGMA journal_mode = WAL');
    insert(db, 'workflow_executions', 'wf-before-archive');

    const stats = workflowStats(path, () => {
      insert(db, 'workflow_executions_archive', 'wf-after-archive');
      db.query('DELETE FROM workflow_executions WHERE id = ?').run('wf-before-archive');
    });

    expect(stats.activeTotal).toBe(1);
    expect(stats.archiveTotal).toBe(0);
    expect(stats.workflowNames).toEqual(['checkout']);
    expect(
      (db.query('SELECT COUNT(*) AS count FROM workflow_executions').get() as { count: number })
        .count
    ).toBe(0);
    db.close();
  });

  test('fails closed on unknown states and includes archive-only workflow names', () => {
    const { db, path } = database();
    insert(db, 'workflow_executions', 'wf-active');
    insert(db, 'workflow_executions_archive', 'wf-archive-only');
    db.query('UPDATE workflow_executions_archive SET workflow_name = ? WHERE id = ?').run(
      'historic-refund',
      'wf-archive-only'
    );
    expect(workflowStats(path).workflowNames).toEqual(['checkout', 'historic-refund']);

    db.query('UPDATE workflow_executions SET state = ? WHERE id = ?').run('corrupt', 'wf-active');
    db.close();
    expect(() => workflowStats(path)).toThrow('unknown execution state');
    expect(() => workflowExecutions(path)).toThrow('invalid execution row');
  });

  test('fails every direct and HTTP read closed on malformed workflow names', async () => {
    const { db, path } = database();
    insert(db, 'workflow_executions', 'wf-invalid-name');
    const manager = new ProcessManager();
    manager.setConfig({ dataPath: path });
    const handle = createFetchHandler(manager, { allowedOrigins: [] });

    for (const invalid of [new Uint8Array([1, 2]), '', 'x'.repeat(257)]) {
      db.query('UPDATE workflow_executions SET workflow_name = ? WHERE id = ?').run(
        invalid,
        'wf-invalid-name'
      );
      expect(() => workflowStats(path)).toThrow('invalid workflow name');
      expect(() => workflowExecutions(path)).toThrow('invalid execution row');
      expect(() => workflowExecution(path, 'wf-invalid-name')).toThrow('invalid execution row');
      for (const [endpoint, error] of [
        ['/workflows/stats', 'Workflow store contains an invalid workflow name'],
        ['/workflows', 'Workflow store contains an invalid execution row'],
        [
          '/workflows/wf-invalid-name?kind=active',
          'Workflow store contains an invalid execution row',
        ],
      ]) {
        const response = await handle(new Request(`http://agent${endpoint}`));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error });
      }
    }
    db.close();
  });

  test('rejects malformed step and nested compensation records before UI transport', () => {
    const { db, path } = database();
    insert(db, 'workflow_executions', 'wf-bad-step');
    const invalidSteps = [
      { charge: null },
      { charge: 'completed' },
      { charge: { status: 'unknown' } },
      { charge: { status: 'completed', attempts: -1 } },
      { charge: { status: 'completed', compensation: null } },
      { charge: { status: 'completed', compensation: { status: 'compensated', at: 'now' } } },
      { charge: { status: 'completed', compensation: { status: 'unknown', at: 1 } } },
    ];
    for (const steps of invalidSteps) {
      db.query('UPDATE workflow_executions SET steps = ? WHERE id = ?').run(
        packr.pack(steps),
        'wf-bad-step'
      );
      expect(() => workflowExecution(path, 'wf-bad-step')).toThrow(
        /invalid (step|compensation) record/
      );
    }
    db.close();
  });

  test('decodes the official structured-clone MessagePack detail contract', () => {
    const { db, path } = database();
    insert(db, 'workflow_executions', 'wf-active');
    db.close();

    expect(workflowExecution(path, 'wf-active')).toEqual(
      expect.objectContaining({
        input: { orderId: 'ord_1' },
        resolvedSteps: ['charge'],
        signals: { approved: { by: 'ops' } },
        decisions: { route: 'card' },
        committedAt: 1,
        steps: {
          charge: expect.objectContaining({
            status: 'failed',
            compensation: expect.objectContaining({ status: 'compensation-failed' }),
          }),
        },
      })
    );
  });

  test('supports archive details and reports an uninitialized store without mutation', () => {
    const { db, path } = database();
    insert(db, 'workflow_executions_archive', 'wf-archived');
    db.run('DROP TABLE workflow_executions');
    db.close();

    expect(workflowStats(path).available).toBe(false);
    expect(workflowExecutions(path).available).toBe(false);
    expect(workflowExecution(path, 'wf-archived', 'archive')?.archivedAt).toBe(3000);
  });

  test('rejects invalid pagination and missing database paths', () => {
    const { db, path } = database();
    db.close();
    expect(() => workflowExecutions(path, { limit: 101 })).toThrow('between 1 and 100');
    expect(() => workflowStats(`${path}-missing`)).toThrow(MissingDbError);
  });

  test('serves overview, waiting, compensation, archive, and detail as distinct HTTP views', async () => {
    const { db, path } = database();
    insert(db, 'workflow_executions', 'wf-waiting');
    db.query("UPDATE workflow_executions SET state = 'waiting' WHERE id = ?").run('wf-waiting');
    insert(db, 'workflow_executions', 'wf-stuck');
    insert(db, 'workflow_executions_archive', 'wf-archived');
    db.close();

    const manager = new ProcessManager();
    manager.setConfig({ dataPath: path });
    const handle = createFetchHandler(manager, { allowedOrigins: [] });
    const request = async (suffix: string) => {
      const response = await handle(new Request(`http://agent${suffix}`));
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    expect((await request('/workflows/stats')).body.activeTotal).toBe(2);
    expect((await request('/workflows?state=waiting')).body.total).toBe(1);
    expect((await request('/workflows?state=compensation')).body.total).toBe(1);
    expect((await request('/workflows?kind=archive')).body.total).toBe(1);
    expect(
      ((await request('/workflows/wf-stuck?kind=active')).body.execution as { id: string }).id
    ).toBe('wf-stuck');
    expect((await request('/workflows?state=unknown')).status).toBe(400);
  });
});
