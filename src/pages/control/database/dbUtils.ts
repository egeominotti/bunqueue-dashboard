import {
  type AgentRequestTarget,
  bq,
  type DbCsvExportResult,
  type DbExportRequest,
} from '@/lib/bq';

const HISTORY_KEY = 'bq-dash-db-history';
const HISTORY_MAX = 10;
const HISTORY_ENTRY_MAX = 20_000;
const HISTORY_SCAN_MAX = 100;

export function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  // Neutralize spreadsheet formula injection on TEXT cells only (a real number
  // can't be a formula, so it keeps numeric fidelity) — mirrors lib/exportFile.ts.
  // A string cell starting with = + - @ (or a leading tab/CR, which Excel strips
  // before evaluating what follows) is executed by Excel/Sheets on open; prefix
  // with a ' so it stays literal text.
  const safe = typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : s;
  // Quote on comma, quote, CR, or LF — a bare \r is a record separator to
  // RFC-4180 parsers and would otherwise split the row.
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
export function toCsv(columns: string[], rows: unknown[][]): string {
  return [columns.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join(
    '\n'
  );
}
export function download(name: string, mime: string, content: BlobPart) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  // Attach before clicking (Firefox ignores a click on a detached anchor) and
  // revoke on the next tick — revoking in the same task can kill the download
  // before the browser has read the blob.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
/** Bound and deduplicate untrusted localStorage before it reaches the DOM. */
export function sanitizeQueryHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const clean: string[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, HISTORY_SCAN_MAX)) {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.length > HISTORY_ENTRY_MAX ||
      seen.has(entry)
    ) {
      continue;
    }
    seen.add(entry);
    clean.push(entry);
    if (clean.length === HISTORY_MAX) break;
  }
  return clean;
}

export function loadHistory(): string[] {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return sanitizeQueryHistory(h);
  } catch {
    return [];
  }
}
export function writeHistory(next: string[]): string[] {
  const safe = sanitizeQueryHistory(next);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(safe));
  } catch {
    /* storage full/unavailable — history is a convenience only */
  }
  return safe;
}
export function pushHistory(sql: string): string[] {
  return writeHistory([sql, ...loadHistory().filter((h) => h !== sql)].slice(0, HISTORY_MAX));
}
/** Pretty-print a value, expanding JSON strings; used by the detail drawer. */
export function pretty(v: unknown): string {
  if (v == null) return 'NULL';
  const s = typeof v === 'string' ? v : String(v);
  // Only expand embedded JSON objects/arrays. Round-tripping every string would
  // rewrite scalar cells the inspector must show verbatim ('1.50' → '1.5',
  // a 20-digit id → a lossy float): an inspector never alters the stored value.
  const t = s.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
      return s;
    }
  }
  return s;
}

export type DbExportSnapshot = DbExportRequest;
export type DbExportResult = DbCsvExportResult;

/**
 * Load a CSV snapshot through one captured agent URL/credential and one frozen
 * table/sort/filter identity. The agent performs the entire export in a single
 * SQLite read transaction; there is no client pagination to mix snapshots.
 */
export async function collectTableExport(
  requested: DbExportSnapshot,
  target: AgentRequestTarget = bq.captureAgentRequestTarget(),
  signal?: AbortSignal
): Promise<DbExportResult> {
  const snapshot: DbExportSnapshot = Object.freeze({
    table: requested.table,
    orderBy: requested.orderBy,
    dir: requested.dir,
    filter: requested.filter ? Object.freeze({ ...requested.filter }) : undefined,
  });
  return bq.getDbExportAtTarget(target, snapshot, signal);
}

export const dbConnectionIdentity = (state: {
  baseUrl: string;
  token: string;
  agentToken: string;
}) => JSON.stringify([state.baseUrl, state.token, state.agentToken]);
