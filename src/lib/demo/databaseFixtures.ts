import type { Json } from './shared';

export const DB_INFO = {
  ok: true,
  sqliteVersion: '3.45.1',
  pageSize: 4096,
  pageCount: 640,
  journalMode: 'wal',
  freelistPages: 8,
  tables: 6,
  indexes: 11,
  fileSize: 2621440,
  walSize: 49152,
};

const DB_DATA: Record<
  string,
  { columns: string[]; types: Record<string, string>; rows: unknown[][] }
> = {
  jobs: {
    columns: ['id', 'queue', 'state', 'priority', 'attempts', 'created_at'],
    types: {
      id: 'TEXT',
      queue: 'TEXT',
      state: 'TEXT',
      priority: 'INTEGER',
      attempts: 'INTEGER',
      created_at: 'INTEGER',
    },
    rows: [
      ['019f252b-86c0-7000-a54e-3816c968ebf0', 'emails', 'prioritized', 1, 0, 1783035037376],
      ['019f252b-8769-7000-bc44-cfc168232f53', 'image-processing', 'active', 0, 0, 1783035037545],
      ['019f252b-86da-7000-a9e3-6b1b74944d70', 'emails', 'completed', 3, 0, 1783035037402],
      ['019f252b-8716-7000-bbec-d8c65e09f340', 'emails', 'failed', 3, 0, 1783035037462],
      ['019f252b-87d8-7000-8f0c-e8ca5fec7d18', 'reports', 'delayed', 0, 0, 1783035037656],
    ],
  },
  queues: {
    columns: ['name', 'paused', 'concurrency', 'rate_limit'],
    types: { name: 'TEXT', paused: 'INTEGER', concurrency: 'INTEGER', rate_limit: 'INTEGER' },
    rows: [
      ['emails', 0, 10, 0],
      ['image-processing', 0, 4, 100],
      ['reports', 0, 2, 0],
      ['notifications', 0, 8, 0],
    ],
  },
  dlq: {
    columns: ['id', 'queue', 'reason', 'attempts', 'entered_at'],
    types: {
      id: 'TEXT',
      queue: 'TEXT',
      reason: 'TEXT',
      attempts: 'INTEGER',
      entered_at: 'INTEGER',
    },
    rows: [
      ['019f252b-8716-7000-bbec-d8c65e09f340', 'emails', 'max attempts reached', 3, 1783035037462],
      ['019f252b-8a02-7000-9b21-4c1f0b7e2a55', 'reports', 'handler threw', 5, 1783035039101],
    ],
  },
  crons: {
    columns: ['name', 'queue', 'pattern', 'tz', 'next_run'],
    types: { name: 'TEXT', queue: 'TEXT', pattern: 'TEXT', tz: 'TEXT', next_run: 'INTEGER' },
    rows: [
      ['nightly-report', 'reports', '0 2 * * *', 'UTC', 1783094400000],
      ['digest-email', 'emails', '*/15 * * * *', 'UTC', 1783035900000],
    ],
  },
  webhooks: {
    columns: ['id', 'url', 'events', 'active', 'failures', 'created_at'],
    types: {
      id: 'TEXT',
      url: 'TEXT',
      events: 'TEXT',
      active: 'INTEGER',
      failures: 'INTEGER',
      created_at: 'INTEGER',
    },
    rows: [
      [
        'wh_9c31',
        'https://hooks.example.com/bunqueue',
        'job:completed,job:failed',
        1,
        0,
        1783034000000,
      ],
    ],
  },
  job_results: {
    columns: ['job_id', 'result', 'stored_at'],
    types: { job_id: 'TEXT', result: 'TEXT', stored_at: 'INTEGER' },
    rows: [
      ['019f252b-86da-7000-a9e3-6b1b74944d70', '{"messageId":"smtp-7712"}', 1783035037999],
      ['019f252b-8769-7000-bc44-cfc168232f53', '{"bytes":184320}', 1783035038220],
      ['019f252b-87d8-7000-8f0c-e8ca5fec7d18', '{"rows":128}', 1783035038511],
      ['019f252b-8a02-7000-9b21-4c1f0b7e2a55', '{"error":"handler threw"}', 1783035039300],
      ['demo-csv-formula', '=SUM(1,2)', 1783035039400],
    ],
  },
};

export function demoDbTable(table: string) {
  return Object.hasOwn(DB_DATA, table) ? DB_DATA[table] : undefined;
}

export const DB_TABLES = {
  ok: true,
  tables: Object.entries(DB_DATA).map(([name, table]) => ({
    name,
    rows: table.rows.length,
    columns: table.columns.length,
  })),
};

export function dbSchema(table: string): Json {
  const value = demoDbTable(table);
  const columns = value?.columns ?? ['id', 'data'];
  const types = value?.types ?? {};
  return {
    ok: true,
    table,
    columns: columns.map((name, index) => ({
      name,
      type: types[name] ?? 'TEXT',
      notNull: index === 0,
      defaultValue: null,
      primaryKey: index === 0,
    })),
    indexes: [{ name: `idx_${table}_${columns[0]}`, unique: true, columns: [columns[0]] }],
    sql: `CREATE TABLE ${table} (${columns.map((name) => `${name} ${types[name] ?? 'TEXT'}`).join(', ')})`,
    rowCount: value?.rows.length ?? 0,
  };
}
