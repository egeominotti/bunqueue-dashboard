/**
 * Small, dependency-free file-export helpers. Additive: extracts the Blob +
 * object-URL download pattern that Database.tsx / RunHistory.tsx / ProcessLogs.tsx
 * each rolled by hand, so the operator-facing pages (Jobs, DLQ, Job Inspector)
 * can offer one-click JSON/CSV export without duplicating it again.
 *
 * All functions are no-ops outside a browser (guarded for tests / SSR).
 */

/** Trigger a browser download of `content` as a file named `filename`. */
export function downloadFile(
  filename: string,
  content: BlobPart,
  mime = 'application/octet-stream'
) {
  if (typeof document === 'undefined') return;
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has definitely been dispatched.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Pretty-print `data` and download it as `<filename>` (‘.json’ appended if missing). */
export function downloadJson(filename: string, data: unknown) {
  const name = filename.endsWith('.json') ? filename : `${filename}.json`;
  downloadFile(name, JSON.stringify(data, null, 2), 'application/json');
}

/**
 * RFC-4180-style CSV cell escaping: quote when the value holds a comma, quote, or
 * newline. Text cells (strings/serialized objects) that begin with a spreadsheet
 * formula trigger (`= + - @`, tab, CR) are prefixed with a `'` so opening the
 * export in Excel/Sheets can't execute attacker-influenced content (e.g. a DLQ
 * error string). Numbers/booleans are never prefixed, preserving numeric columns.
 */
function csvCell(value: unknown): string {
  if (value == null) return '';
  const isText = typeof value !== 'number' && typeof value !== 'boolean';
  let s = typeof value === 'object' ? JSON.stringify(value) : String(value as string | number);
  if (isText && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialize an array of records to CSV. `columns` fixes the column order (and
 * limits which keys are emitted); when omitted, the union of keys across every
 * row is used, in first-seen order.
 */
export function toCsv(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns?: readonly string[]
): string {
  const cols =
    columns ??
    (() => {
      const seen: string[] = [];
      const set = new Set<string>();
      for (const row of rows) {
        for (const k of Object.keys(row)) {
          if (!set.has(k)) {
            set.add(k);
            seen.push(k);
          }
        }
      }
      return seen;
    })();
  const header = cols.map(csvCell).join(',');
  const body = rows.map((row) => cols.map((c) => csvCell(row[c])).join(',')).join('\n');
  return body ? `${header}\n${body}` : header;
}

/** Serialize `rows` to CSV and download them as `<filename>` (‘.csv’ appended if missing). */
export function downloadCsv(
  filename: string,
  rows: ReadonlyArray<Record<string, unknown>>,
  columns?: readonly string[]
) {
  const name = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  downloadFile(name, toCsv(rows, columns), 'text/csv;charset=utf-8');
}
