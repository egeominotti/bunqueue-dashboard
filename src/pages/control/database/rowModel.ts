import type { DbFilter, DbRowsPage } from '@/lib/bq';

export interface DbRowsIdentity {
  table: string;
  limit: number;
  offset: number;
  orderBy?: string;
  dir: 'asc' | 'desc';
  filter?: DbFilter;
}

const sameFilter = (actual: DbFilter | null, expected?: DbFilter) =>
  expected
    ? actual?.column === expected.column &&
      actual.op === expected.op &&
      actual.value === expected.value
    : actual === null;

export function dbRowsMatchIdentity(page: DbRowsPage, expected: DbRowsIdentity): boolean {
  return (
    page.table === expected.table &&
    page.limit === expected.limit &&
    page.offset === expected.offset &&
    page.orderBy === (expected.orderBy ?? null) &&
    page.dir === expected.dir &&
    sameFilter(page.filter, expected.filter)
  );
}

const MIN_SQLITE_INTEGER = -(1n << 63n);
const MAX_SQLITE_INTEGER = (1n << 63n) - 1n;

function validRowid(value: unknown): value is number | string | null {
  if (value === null) return true;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)$/.test(value) || value.length > 20) {
    return false;
  }
  try {
    const integer = BigInt(value);
    return integer >= MIN_SQLITE_INTEGER && integer <= MAX_SQLITE_INTEGER;
  } catch {
    return false;
  }
}

const validDbCell = (value: unknown) =>
  value === null ||
  typeof value === 'string' ||
  (typeof value === 'number' && Number.isFinite(value));

/**
 * Validate every field used by the database grid before rendering. Identity is
 * part of the payload contract, not a best-effort UI check: a response for a
 * different table/page/sort/filter is rejected like any other malformed 2xx.
 */
export function parseDbRowsResponse(value: unknown, expected: DbRowsIdentity): DbRowsPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Malformed database rows response.');
  }
  const result = value as Record<string, unknown>;
  const columns = result.columns;
  const rows = result.rows;
  const rowids = result.rowids;
  const truncatedCells = result.truncatedCells;
  const filter = result.filter;
  const filterValid =
    filter === null ||
    (filter !== null &&
      typeof filter === 'object' &&
      !Array.isArray(filter) &&
      typeof (filter as Record<string, unknown>).column === 'string' &&
      ((filter as Record<string, unknown>).op === 'contains' ||
        (filter as Record<string, unknown>).op === 'eq' ||
        (filter as Record<string, unknown>).op === 'ne') &&
      typeof (filter as Record<string, unknown>).value === 'string');

  if (
    result.ok !== true ||
    typeof result.table !== 'string' ||
    !Array.isArray(columns) ||
    columns.length === 0 ||
    columns.length > 2000 ||
    columns.some((column) => typeof column !== 'string' || !column) ||
    new Set(columns).size !== columns.length ||
    !Array.isArray(rows) ||
    rows.length > expected.limit ||
    rows.some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== columns.length ||
        row.some((cell) => !validDbCell(cell))
    ) ||
    !Array.isArray(rowids) ||
    rowids.length !== rows.length ||
    rowids.some((rowid) => !validRowid(rowid)) ||
    !Array.isArray(truncatedCells) ||
    truncatedCells.length !== rows.length ||
    truncatedCells.some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== columns.length ||
        row.some((cell) => typeof cell !== 'boolean')
    ) ||
    !Number.isSafeInteger(result.total) ||
    (result.total as number) < 0 ||
    !Number.isSafeInteger(result.limit) ||
    !Number.isSafeInteger(result.offset) ||
    (result.offset as number) < 0 ||
    (result.orderBy !== null && typeof result.orderBy !== 'string') ||
    (result.dir !== 'asc' && result.dir !== 'desc') ||
    !filterValid
  ) {
    throw new Error('Malformed database rows response.');
  }

  const page = {
    ok: true,
    table: result.table,
    columns: [...(columns as string[])],
    rows: (rows as unknown[][]).map((row) => [...row]),
    rowids: [...(rowids as (number | string | null)[])],
    truncatedCells: (truncatedCells as boolean[][]).map((row) => [...row]),
    total: result.total as number,
    limit: result.limit as number,
    offset: result.offset as number,
    orderBy: result.orderBy as string | null,
    dir: result.dir as 'asc' | 'desc',
    filter: filter === null ? null : ({ ...(filter as DbFilter) } satisfies DbFilter),
  } satisfies DbRowsPage;

  if (!dbRowsMatchIdentity(page, expected)) {
    throw new Error(
      `Database rows identity mismatch: requested table "${expected.table}" at offset ${expected.offset}.`
    );
  }
  const expectedRows = Math.min(page.limit, Math.max(0, page.total - page.offset));
  if (page.rows.length !== expectedRows) {
    throw new Error(
      'Malformed database rows response: row count does not match pagination metadata.'
    );
  }
  return page;
}

export interface DbDetailSelection {
  index: number;
  table: string;
  columns: string[];
  row: unknown[];
  rowid: number | string | null;
  truncated: boolean[];
}

/** Capture the exact validated row shown when the operator opens the drawer. */
export function createDbDetailSelection(page: DbRowsPage, index: number): DbDetailSelection | null {
  const row = page.rows[index];
  const truncated = page.truncatedCells[index];
  const rowid = page.rowids[index];
  if (!row || !truncated || rowid === undefined || index < 0) return null;
  return {
    index,
    table: page.table,
    columns: [...page.columns],
    row: [...row],
    rowid,
    truncated: [...truncated],
  };
}

const sameArray = (left: readonly unknown[], right: readonly unknown[]) =>
  left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

/**
 * A poll may replace or shift the positional row while a drawer is open. Keep
 * the immutable selection only while table, rowid and row fingerprint still
 * match. For WITHOUT ROWID tables, the full row fingerprint is the identity.
 */
export function dbDetailMatchesPage(selection: DbDetailSelection, page: DbRowsPage): boolean {
  const current = createDbDetailSelection(page, selection.index);
  return (
    current !== null &&
    current.table === selection.table &&
    current.rowid === selection.rowid &&
    sameArray(current.columns, selection.columns) &&
    sameArray(current.row, selection.row) &&
    sameArray(current.truncated, selection.truncated)
  );
}
