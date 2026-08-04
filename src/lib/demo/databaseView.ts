import { demoDbTable } from './databaseFixtures';
import type { Json } from './shared';

type DemoDbFilter = { column: string; op: 'contains' | 'eq' | 'ne'; value: string };

interface DemoDbView {
  table: string;
  columns: string[];
  rows: unknown[][];
  orderBy: string | null;
  dir: 'asc' | 'desc';
  filter: DemoDbFilter | null;
}

const asciiFold = (value: string): string =>
  value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

function dbView(table: string, search: string, strictExport = false): DemoDbView {
  const value = demoDbTable(table);
  if (strictExport && !value) throw new Error(`No such table: ${table}`);
  const columns = value?.columns ?? ['id', 'data'];
  const all = value?.rows ?? [];
  const params = new URLSearchParams(search);

  if (strictExport) {
    const allowed = new Set(['orderBy', 'dir', 'fcol', 'fop', 'fval']);
    for (const key of params.keys()) {
      if (!allowed.has(key)) throw new Error(`Unknown database export option: ${key}`);
      if (params.getAll(key).length !== 1) {
        throw new Error(`Duplicate database export option: ${key}`);
      }
    }
  }

  const orderByParam = params.get('orderBy');
  if (strictExport && orderByParam === '') {
    throw new Error('Database export orderBy must not be empty');
  }
  const orderBy = orderByParam || null;
  const dirParam = params.get('dir');
  if (strictExport && dirParam !== null && dirParam !== 'asc' && dirParam !== 'desc') {
    throw new Error('Database export dir must be "asc" or "desc"');
  }
  const dir: 'asc' | 'desc' = dirParam === 'desc' ? 'desc' : 'asc';

  const fCol = params.get('fcol');
  const fOp = params.get('fop');
  const fVal = params.get('fval');
  const hasAnyFilterPart = fCol !== null || fOp !== null || fVal !== null;
  if (
    strictExport &&
    hasAnyFilterPart &&
    (!fCol || !fVal || (fOp !== 'contains' && fOp !== 'eq' && fOp !== 'ne'))
  ) {
    throw new Error('Database export filter requires valid fcol, fop and fval values');
  }
  const filter: DemoDbFilter | null =
    fCol && fVal
      ? {
          column: fCol,
          op: fOp === 'eq' ? 'eq' : fOp === 'ne' ? 'ne' : 'contains',
          value: fVal,
        }
      : null;

  const filterColumn = filter ? columns.indexOf(filter.column) : -1;
  if (filter && filterColumn < 0 && strictExport) {
    throw new Error(`No such column: ${filter.column}`);
  }
  const filtered =
    filter && filterColumn >= 0
      ? all.filter((row) => {
          const cell = row[filterColumn];
          if (cell == null) return false;
          const text = String(cell);
          if (filter.op === 'eq') return text === filter.value;
          if (filter.op === 'ne') return text !== filter.value;
          return asciiFold(text).includes(asciiFold(filter.value));
        })
      : all;

  const sortColumn = orderBy ? columns.indexOf(orderBy) : -1;
  if (orderBy && sortColumn < 0 && strictExport) throw new Error(`No such column: ${orderBy}`);
  const rows =
    sortColumn >= 0
      ? [...filtered].sort((a, b) => {
          const x = a[sortColumn] as string | number | null;
          const y = b[sortColumn] as string | number | null;
          const cmp = x == null ? (y == null ? 0 : -1) : y == null ? 1 : x < y ? -1 : x > y ? 1 : 0;
          return dir === 'desc' ? -cmp : cmp;
        })
      : filtered;

  return {
    table,
    columns,
    rows,
    orderBy: sortColumn >= 0 ? orderBy : null,
    dir,
    filter: filterColumn >= 0 ? filter : null,
  };
}

export function dbRows(table: string, search: string): Json {
  const view = dbView(table, search);
  const params = new URLSearchParams(search);
  const numberParam = (entry: string | null, fallback: number): number => {
    const parsed = Number(entry);
    return entry !== null && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  const limit = numberParam(params.get('limit'), 50);
  const offset = numberParam(params.get('offset'), 0);
  const rows = view.rows.slice(offset, offset + (limit > 0 ? limit : view.rows.length));
  return {
    ok: true,
    table,
    columns: view.columns,
    rows,
    rowids: rows.map((_, index) => offset + index + 1),
    truncatedCells: rows.map((row) => row.map(() => false)),
    total: view.rows.length,
    limit,
    offset,
    orderBy: view.orderBy,
    dir: view.dir,
    filter: view.filter,
  };
}

const MAX_ROWS = 200_000;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 2000;
const TEXT_PREFIX_CHARS = 2000;

function dbCsvCell(value: unknown): string {
  let text: string;
  let textual = false;
  if (value == null) text = '';
  else if (typeof value === 'string') {
    text =
      new TextEncoder().encode(value).byteLength > MAX_TEXT_BYTES
        ? `${[...value].slice(0, TEXT_PREFIX_CHARS).join('')}…`
        : value;
    textual = true;
  } else if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    text = String(value);
  } else if (value instanceof Uint8Array) {
    text = `<blob ${value.byteLength} B>`;
    textual = true;
  } else {
    throw new Error('Database export produced an unsupported SQLite value');
  }
  const safe = textual && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function dbExportResponse(table: string, search: string): Response {
  try {
    const view = dbView(table, search, true);
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let rowCount = 0;
    let cap: 'rows' | 'bytes' | null = null;
    const append = (line: string): boolean => {
      const encoded = encoder.encode(line);
      if (bytes + encoded.byteLength > MAX_BYTES) return false;
      chunks.push(encoded);
      bytes += encoded.byteLength;
      return true;
    };
    if (!append(view.columns.map(dbCsvCell).join(','))) {
      throw new Error(`Database export header exceeds the ${MAX_BYTES}-byte export limit`);
    }
    for (const row of view.rows) {
      if (rowCount >= MAX_ROWS) {
        cap = 'rows';
        break;
      }
      if (!append(`\r\n${row.map(dbCsvCell).join(',')}`)) {
        cap = 'bytes';
        break;
      }
      rowCount++;
    }
    const content = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(content, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Length': String(bytes),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Bunqueue-Db-Export-Version': '1',
        'X-Bunqueue-Db-Export-Table': encodeURIComponent(view.table),
        'X-Bunqueue-Db-Export-Rows': String(rowCount),
        'X-Bunqueue-Db-Export-Bytes': String(bytes),
        'X-Bunqueue-Db-Export-Cap': cap ?? 'none',
        'Access-Control-Expose-Headers':
          'Content-Length, X-Bunqueue-Db-Export-Version, X-Bunqueue-Db-Export-Table, X-Bunqueue-Db-Export-Rows, X-Bunqueue-Db-Export-Bytes, X-Bunqueue-Db-Export-Cap',
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
