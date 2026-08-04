import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import {
  DB_EXPORT_MAX_BYTES,
  DB_EXPORT_MAX_ROWS,
  MAX_CELL,
  MissingDbError,
  type DbFilter,
  type DbRowId,
} from './types';

export function openDb(path: string): Database {
  try {
    if (!Bun.file(path).size && !existsSync(path)) {
      throw new MissingDbError(
        `Database not found at "${path}" — start the server once to create it.`
      );
    }
  } catch (error) {
    if (error instanceof MissingDbError) throw error;
  }
  try {
    return new Database(path, { readonly: true });
  } catch (error) {
    if (!existsSync(path)) {
      throw new MissingDbError(
        `Database not found at "${path}" — start the server once to create it.`
      );
    }
    throw new Error(`Could not open database: ${(error as Error).message}`);
  }
}

export const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export function isTruncated(value: unknown): boolean {
  return (
    (value instanceof Uint8Array && value.byteLength > 0) ||
    (typeof value === 'string' && value.length > MAX_CELL)
  );
}

export function bigintCell(value: bigint): number | string {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

export function jsonCell(value: unknown): unknown {
  if (value instanceof Uint8Array) return `<blob ${value.byteLength} B>`;
  if (typeof value === 'string' && value.length > MAX_CELL) {
    return `${value.slice(0, MAX_CELL)}…`;
  }
  if (typeof value === 'bigint') return bigintCell(value);
  return value;
}

export const sanitize = (rows: unknown[][]): unknown[][] =>
  rows.map((row) => row.map(jsonCell));

const MIN_SQLITE_INTEGER = -(1n << 63n);
const MAX_SQLITE_INTEGER = (1n << 63n) - 1n;

export function boundRowid(rowid: DbRowId): DbRowId {
  if (typeof rowid === 'number') {
    if (!Number.isSafeInteger(rowid)) throw new Error('Invalid rowid');
    return rowid;
  }
  if (rowid.length === 0 || rowid.length > 20 || !/^-?\d+$/.test(rowid)) {
    throw new Error('Invalid rowid');
  }
  const integer = BigInt(rowid);
  if (integer < MIN_SQLITE_INTEGER || integer > MAX_SQLITE_INTEGER) {
    throw new Error('Invalid rowid');
  }
  return rowid;
}

/** bun:sqlite exposes this at runtime but does not type it. */
export function safeIntegers(statement: unknown): void {
  (statement as { safeIntegers?: (on: boolean) => void }).safeIntegers?.(true);
}

export function knownTable(db: Database, table: string): string {
  const known = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | null;
  if (!known) throw new Error(`No such table: ${table}`);
  return known.name;
}

export function buildFilter(
  columns: string[],
  filter: DbFilter | undefined
): { clause: string; params: unknown[]; applied: DbFilter | null } {
  if (!filter || !filter.value) return { clause: '', params: [], applied: null };
  const column = columns.find((candidate) => candidate === filter.column);
  if (!column) throw new Error(`No such column: ${filter.column}`);
  const quoted = ident(column);
  if (filter.op === 'eq') {
    return { clause: ` WHERE ${quoted} = ?`, params: [filter.value], applied: filter };
  }
  if (filter.op === 'ne') {
    return { clause: ` WHERE ${quoted} <> ?`, params: [filter.value], applied: filter };
  }
  const needle = filter.value
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
  return {
    clause: ` WHERE ${quoted} LIKE ? ESCAPE '\\'`,
    params: [`%${needle}%`],
    applied: { ...filter, op: 'contains' },
  };
}

export function boundedExportLimit(
  value: number | undefined,
  hardCap: number,
  label: string
): number {
  if (value === undefined) return hardCap;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Math.min(value, hardCap);
}

export function validateWorkerBounds(rows: number, bytes: number): boolean {
  return rows >= 0 && rows <= DB_EXPORT_MAX_ROWS && bytes >= 1 && bytes <= DB_EXPORT_MAX_BYTES;
}

export function translateDbError(error: unknown): Error {
  const message = String((error as Error)?.message ?? error);
  if (/readonly|read-only|SQLITE_READONLY/i.test(message)) {
    return new Error(
      'Connection is read-only — INSERT / UPDATE / DELETE / DDL are not permitted here.'
    );
  }
  return error instanceof Error ? error : new Error(message);
}
