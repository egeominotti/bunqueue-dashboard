import {
  type DbFilter,
  dbCell,
  dbInfo,
  dbRows,
  dbSchema,
  dbTables,
  exportWithTimeout,
  queryWithTimeout,
} from '../db';
import { corsHeaders } from './policy';
import { readLimitedJsonBody } from './jsonBody';
import type { RouteResponse } from './types';

const MAX_QUERY_BODY_BYTES = 64 * 1024;

function exportFilter(query: URLSearchParams): DbFilter | undefined {
  const column = query.get('fcol');
  const operation = query.get('fop');
  const value = query.get('fval');
  const hasPart = column !== null || operation !== null || value !== null;
  if (!hasPart) return undefined;
  if (
    !column ||
    !value ||
    (operation !== 'contains' && operation !== 'eq' && operation !== 'ne')
  ) {
    throw new Error('Database export filter requires valid fcol, fop and fval values');
  }
  return { column, op: operation, value };
}

function validateExportQuery(query: URLSearchParams): void {
  const allowed = new Set(['orderBy', 'dir', 'fcol', 'fop', 'fval']);
  for (const key of query.keys()) {
    if (!allowed.has(key)) throw new Error(`Unknown database export option: ${key}`);
    if (query.getAll(key).length !== 1) {
      throw new Error(`Duplicate database export option: ${key}`);
    }
  }
}

async function exportTable(
  request: Request,
  table: string,
  dataPath: string,
  origin: string | null,
  allowedOrigins: string[]
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  validateExportQuery(query);
  const orderBy = query.get('orderBy');
  if (orderBy === '') throw new Error('Database export orderBy must not be empty');
  const direction = query.get('dir');
  if (direction !== null && direction !== 'asc' && direction !== 'desc') {
    throw new Error('Database export dir must be "asc" or "desc"');
  }
  const exported = await exportWithTimeout(
    dataPath,
    table,
    orderBy ?? undefined,
    direction === 'desc' ? 'desc' : 'asc',
    exportFilter(query),
    request.signal
  );
  return new Response(exported.content, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': String(exported.bytes),
      'Cache-Control': 'no-store, no-transform',
      'X-Content-Type-Options': 'nosniff',
      'X-Bunqueue-Db-Export-Version': '1',
      'X-Bunqueue-Db-Export-Table': encodeURIComponent(exported.table),
      'X-Bunqueue-Db-Export-Rows': String(exported.rowCount),
      'X-Bunqueue-Db-Export-Bytes': String(exported.bytes),
      'X-Bunqueue-Db-Export-Cap': exported.cap ?? 'none',
      'Access-Control-Expose-Headers':
        'Content-Length, X-Bunqueue-Db-Export-Version, X-Bunqueue-Db-Export-Table, X-Bunqueue-Db-Export-Rows, X-Bunqueue-Db-Export-Bytes, X-Bunqueue-Db-Export-Cap',
      ...corsHeaders(origin, allowedOrigins),
    },
  });
}

function browseFilter(query: URLSearchParams): DbFilter | undefined {
  const column = query.get('fcol');
  const operation = query.get('fop');
  const value = query.get('fval');
  if (!column || !value) return undefined;
  return {
    column,
    op: operation === 'eq' ? 'eq' : operation === 'ne' ? 'ne' : 'contains',
    value,
  };
}

export async function routeDatabaseRequest(
  request: Request,
  pathname: string,
  method: string,
  dataPath: string,
  origin: string | null,
  allowedOrigins: string[]
): Promise<RouteResponse | Response | null> {
  if (pathname === '/db/info' && method === 'GET') {
    return { status: 200, body: { ok: true, ...dbInfo(dataPath) } };
  }
  if (pathname === '/db/tables' && method === 'GET') {
    return { status: 200, body: { ok: true, tables: dbTables(dataPath) } };
  }
  if (pathname.startsWith('/db/tables/') && method === 'GET') {
    const segments = pathname.slice('/db/tables/'.length).split('/');
    const table = decodeURIComponent(segments[0] ?? '');
    const subresource = segments[1];
    if (segments.length === 2 && subresource === 'export') {
      return exportTable(request, table, dataPath, origin, allowedOrigins);
    }
    if (segments.length === 2 && subresource === 'schema') {
      return { status: 200, body: { ok: true, ...dbSchema(dataPath, table) } };
    }
    if (segments.length === 2 && subresource === 'cell') {
      const query = new URL(request.url).searchParams;
      const rowid = query.get('rowid');
      if (rowid === null) throw new Error('rowid is required');
      return {
        status: 200,
        body: {
          ok: true,
          ...dbCell(dataPath, table, rowid, query.get('column') ?? ''),
        },
      };
    }
    if (segments.length !== 1) {
      return { status: 404, body: { ok: false, error: 'Not found' } };
    }
    const query = new URL(request.url).searchParams;
    return {
      status: 200,
      body: {
        ok: true,
        ...dbRows(
          dataPath,
          table,
          Number(query.get('limit')) || 50,
          Number(query.get('offset')) || 0,
          query.get('orderBy') || undefined,
          query.get('dir') === 'desc' ? 'desc' : 'asc',
          browseFilter(query)
        ),
      },
    };
  }
  if (pathname === '/db/query' && method === 'POST') {
    const { sql } = (await readLimitedJsonBody(request, {
      scope: 'Database query',
      maxBytes: MAX_QUERY_BODY_BYTES,
      limitLabel: '64 KiB',
    })) as { sql?: string };
    return {
      status: 200,
      body: { ok: true, ...(await queryWithTimeout(dataPath, sql ?? '')) },
    };
  }
  return null;
}
