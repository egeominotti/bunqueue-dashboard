import {
  AGENT_EXPORT_MAX_BYTES,
  AGENT_EXPORT_MAX_ROWS,
  bq,
  CLIENT_EXPORT_MAX_BYTES,
  CLIENT_EXPORT_MAX_ROWS,
  describe,
  expect,
  fetchHarness,
  headerOf,
  installTestHooks,
  lastCall,
  SAFE_AGENT_BASE,
  test,
  useConnectionStore,
} from './bq.helpers';

installTestHooks();

describe('bq request construction', () => {
  test('Workflow Engine reads use the agent contract and encode execution ids', async () => {
    await bq.workflows.list({
      kind: 'archive',
      workflowName: 'order/fulfillment',
      state: 'compensation-stuck',
      limit: 25,
      offset: 50,
    });
    expect(lastCall().url).toBe(
      `${SAFE_AGENT_BASE}/workflows?kind=archive&workflowName=order%2Ffulfillment&state=compensation-stuck&limit=25&offset=50`
    );

    await bq.workflows.get('run/2026 #1', 'active');
    expect(lastCall().url).toBe(`${SAFE_AGENT_BASE}/workflows/run%2F2026%20%231?kind=active`);
  });

  test('database CSV export uses one target-pinned request and validates raw metadata', async () => {
    expect(CLIENT_EXPORT_MAX_ROWS).toBe(AGENT_EXPORT_MAX_ROWS);
    expect(CLIENT_EXPORT_MAX_BYTES).toBe(AGENT_EXPORT_MAX_BYTES);
    useConnectionStore.getState().setAgentToken('export-token');
    const csv = new TextEncoder().encode('id\r\n1');
    fetchHarness.responder = () =>
      new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Length': String(csv.byteLength),
          'X-Bunqueue-Db-Export-Version': '1',
          'X-Bunqueue-Db-Export-Table': encodeURIComponent('job rows'),
          'X-Bunqueue-Db-Export-Rows': '1',
          'X-Bunqueue-Db-Export-Bytes': String(csv.byteLength),
          'X-Bunqueue-Db-Export-Cap': 'none',
        },
      });

    const exported = await bq.getDbExportAtTarget(bq.captureAgentRequestTarget(), {
      table: 'job rows',
      orderBy: 'id',
      dir: 'desc',
      filter: { column: 'state', op: 'eq', value: 'failed' },
    });
    expect(lastCall().url).toBe(
      'http://localhost:6800/db/tables/job%20rows/export?orderBy=id&dir=desc&fcol=state&fop=eq&fval=failed'
    );
    expect(headerOf(lastCall().init, 'Authorization')).toBe('Bearer export-token');
    expect(exported).toMatchObject({
      table: 'job rows',
      rowCount: 1,
      bytes: csv.byteLength,
      cap: null,
    });
    expect(new TextDecoder().decode(exported.content)).toBe('id\r\n1');
  });

  test('database CSV export rejects a mismatched table or contradictory length metadata', async () => {
    const response = (table: string, bytes: string, contentLength = '5') =>
      new Response('id\r\n1', {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Length': contentLength,
          'X-Bunqueue-Db-Export-Version': '1',
          'X-Bunqueue-Db-Export-Table': encodeURIComponent(table),
          'X-Bunqueue-Db-Export-Rows': '1',
          'X-Bunqueue-Db-Export-Bytes': bytes,
          'X-Bunqueue-Db-Export-Cap': 'none',
        },
      });
    fetchHarness.responder = () => response('other', '5');
    await expect(
      bq.getDbExportAtTarget(bq.captureAgentRequestTarget(), { table: 'jobs', dir: 'asc' })
    ).rejects.toThrow('requested "jobs", received "other"');

    fetchHarness.responder = () => response('jobs', '4');
    await expect(
      bq.getDbExportAtTarget(bq.captureAgentRequestTarget(), { table: 'jobs', dir: 'asc' })
    ).rejects.toThrow('Content-Length does not match');

    fetchHarness.responder = () => response('jobs', '4', '4');
    await expect(
      bq.getDbExportAtTarget(bq.captureAgentRequestTarget(), { table: 'jobs', dir: 'asc' })
    ).rejects.toThrow('body exceeds declared 4 bytes');

    fetchHarness.responder = () => response('jobs', '5', 'not-a-number');
    await expect(
      bq.getDbExportAtTarget(bq.captureAgentRequestTarget(), { table: 'jobs', dir: 'asc' })
    ).rejects.toThrow('invalid Content-Length header');

    fetchHarness.responder = () => response('jobs', '5', String(CLIENT_EXPORT_MAX_BYTES + 1));
    await expect(
      bq.getDbExportAtTarget(bq.captureAgentRequestTarget(), { table: 'jobs', dir: 'asc' })
    ).rejects.toThrow('invalid Content-Length header');
  });

  test('db.cell preserves and encodes an exact 64-bit rowid', async () => {
    await bq.db.cell('job rows', '9007199254740993', 'payload/value');
    expect(lastCall().url).toBe(
      'http://localhost:6800/db/tables/job%20rows/cell?rowid=9007199254740993&column=payload%2Fvalue'
    );
  });

  test('uses each upstream route decoding contract and rejects dot retargeting locally', async () => {
    await bq.jobByCustomId('order /:%');
    expect(lastCall().url).toBe('http://srv/jobs/custom/order%20%2F%3A%25');

    await bq.deleteCron('nightly /:%');
    expect(lastCall().url).toBe('http://srv/crons/nightly%20%2F%3A%25');

    await bq.removeWebhook('hook:@+');
    expect(lastCall().url).toBe('http://srv/webhooks/hook:@+');

    const before = fetchHarness.calls.length;
    expect(() => bq.jobByCustomId('.')).toThrow('path traversal segment');
    expect(() => bq.deleteCron('..')).toThrow('path traversal segment');
    expect(() => bq.db.schema('.')).toThrow('path traversal segment');
    expect(() => bq.removeWebhook('..')).toThrow('path traversal segment');
    await expect(bq.getDbRowsAtTarget(bq.captureAgentRequestTarget(), '.', 50, 0)).rejects.toThrow(
      'path traversal segment'
    );
    expect(fetchHarness.calls).toHaveLength(before);
  });

  test('eventsUrl tracks the live baseUrl and preserves the raw v2.8.55 queue suffix', () => {
    expect(bq.eventsUrl()).toBe('http://srv/events');
    expect(bq.eventsUrl('foo:bar')).toBe('http://srv/events/queues/foo:bar');
    expect(() => bq.eventsUrl('a/b')).toThrow('Invalid Bunqueue queue name');
    useConnectionStore.getState().setBaseUrl('http://other/');
    expect(bq.eventsUrl()).toBe('http://other/events');
  });
});
