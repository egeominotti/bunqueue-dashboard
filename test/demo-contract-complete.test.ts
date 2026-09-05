import { describe, expect, test } from 'bun:test';
import { demoBackupResponse } from '../src/lib/demo/backups';
import { DEMO_CONFIG, demoControlLogs, demoStatus, demoWorkers } from '../src/lib/demo/control';
import { demoWorkflowResponse } from '../src/lib/demo/workflows';

describe('demo backup contract', () => {
  test('covers every supported status, list and mutation route', () => {
    expect(demoBackupResponse(['backup', 'status'], 'GET')).toMatchObject({
      ok: true,
      result: { data: { enabled: true, bucket: 'bunqueue-demo-backups' } },
    });
    const listed = demoBackupResponse(['backup', 'list'], 'GET') as Record<string, any>;
    expect(listed).toMatchObject({ ok: true, result: { success: true } });
    expect(listed.result.data).toHaveLength(2);
    expect(listed.result.data[0]).toMatchObject({ key: 'backups/bunqueue-2026-08-04.db' });
    expect(demoBackupResponse(['backup', 'configure'], 'POST')).toEqual({
      ok: true,
      result: { configured: true, enabled: true },
    });
    expect(demoBackupResponse(['backup', 'now'], 'POST')).toMatchObject({
      ok: true,
      result: { data: { key: 'backups/bunqueue-demo-now.db' } },
    });
    expect(demoBackupResponse(['backup', 'restore'], 'POST')).toMatchObject({
      ok: true,
      result: { success: true },
    });
  });

  test('rejects wrong methods and unknown operations', () => {
    expect(demoBackupResponse(['backup', 'status'], 'POST')).toEqual({
      ok: false,
      error: 'Demo backup route not found',
    });
    expect(demoBackupResponse(['backup', 'missing'], 'GET')).toEqual({
      ok: false,
      error: 'Demo backup route not found',
    });
  });
});

describe('demo control contract', () => {
  test('reports a coherent managed process and database snapshot', () => {
    const before = Date.now();
    const status = demoStatus() as Record<string, any>;
    expect(status).toMatchObject({
      status: 'running',
      healthy: true,
      version: '2.9.4',
      config: DEMO_CONFIG,
      runningConfig: DEMO_CONFIG,
      db: { exists: true, totalSize: 2_703_360 },
    });
    expect(status.startedAt).toBeLessThanOrEqual(before - 3_599_000);
    expect(status.db.mtimeMs).toBeLessThanOrEqual(Date.now());
  });

  test('serves active and stale workers plus ordered process log streams', () => {
    const workers = demoWorkers() as Record<string, any>;
    expect(workers.data.stats).toEqual({
      total: 3,
      active: 2,
      totalProcessed: 1683,
      totalFailed: 7,
      activeJobs: 2,
    });
    expect(workers.data.workers.map((worker: any) => worker.status)).toEqual([
      'active',
      'active',
      'stale',
    ]);
    const logs = demoControlLogs() as Record<string, any>;
    expect(logs.lines.map((line: any) => line.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(logs.lines.map((line: any) => line.stream)).toEqual([
      'sys',
      'stdout',
      'stdout',
      'stdout',
      'stdout',
    ]);
    expect(logs.lines[0].line).toContain('bunqueue@2.9.4');
  });
});

describe('demo workflow contract', () => {
  test('reports exact state totals and stable workflow names', () => {
    expect(demoWorkflowResponse(['workflows', 'stats'], '', 'GET')).toEqual({
      ok: true,
      available: true,
      activeTotal: 3,
      archiveTotal: 2,
      states: {
        running: 1,
        waiting: 1,
        completed: 0,
        failed: 0,
        compensating: 0,
        'compensation-stuck': 1,
      },
      workflowNames: [
        'customer-onboarding',
        'legacy-import',
        'month-end-close',
        'order-fulfillment',
        'refund-order',
      ],
    });
  });

  test('filters and paginates active and archived summaries without leaking payloads', () => {
    const active = demoWorkflowResponse(
      ['workflows'],
      '?state=compensation&offset=0&limit=1',
      'GET'
    ) as Record<string, any>;
    expect(active).toMatchObject({ ok: true, total: 1, limit: 1, offset: 0 });
    expect(active.executions).toHaveLength(1);
    expect(active.executions[0]).toMatchObject({
      id: 'wf-refund-2026-0803',
      state: 'compensation-stuck',
    });
    expect(active.executions[0].steps).toBeUndefined();
    expect(active.executions[0].input).toBeUndefined();

    const archive = demoWorkflowResponse(
      ['workflows'],
      '?kind=archive&workflowName=legacy-import',
      'GET'
    ) as Record<string, any>;
    expect(archive).toMatchObject({ total: 1 });
    expect(archive.executions[0].id).toBe('wf-import-legacy-441');
  });

  test('returns full details and rejects an unknown execution', () => {
    const detail = demoWorkflowResponse(['workflows', 'wf-signup-2026-0802'], '', 'GET') as Record<
      string,
      any
    >;
    expect(detail.execution).toMatchObject({
      state: 'waiting',
      input: { customerId: 'cus_881', plan: 'pro' },
    });
    expect(detail.execution.steps.createAccount.result.accountId).toBe('acc_881');
    expect(demoWorkflowResponse(['workflows', 'missing'], '', 'GET')).toEqual({
      ok: false,
      error: 'Workflow execution not found',
    });
  });

  test('covers every runtime and lifecycle command envelope', () => {
    expect(demoWorkflowResponse(['workflows', 'runtime'], '', 'GET')).toMatchObject({
      ok: true,
      result: { configured: true, ready: true },
    });
    expect(demoWorkflowResponse(['workflows', 'runtime', 'reload'], '', 'POST')).toMatchObject({
      ok: true,
      result: { moduleName: 'demo-workflows' },
    });
    expect(demoWorkflowResponse(['workflows', 'start'], '', 'POST')).toMatchObject({
      result: { run: { id: 'wf-demo-started' } },
    });
    expect(demoWorkflowResponse(['workflows', 'recover'], '', 'POST')).toMatchObject({
      result: { recovered: { total: 2 } },
    });
    for (const command of ['archive', 'cleanup']) {
      expect(demoWorkflowResponse(['workflows', command], '', 'POST')).toEqual({
        ok: true,
        result: { affected: 1 },
      });
    }
    for (const command of ['signal', 'resume-compensation', 'abandon-compensation']) {
      expect(demoWorkflowResponse(['workflows', 'wf-id', command], '', 'POST')).toEqual({
        ok: true,
        result: { applied: true },
      });
    }
  });
});
