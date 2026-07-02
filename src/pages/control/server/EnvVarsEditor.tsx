import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/form';

interface Row {
  id: number;
  key: string;
  value: string;
}

let nextId = 0;
const rowsFromObj = (o: Record<string, string>): Row[] =>
  Object.entries(o).map(([key, value]) => ({ id: nextId++, key, value }));
const objFromRows = (rows: Row[]): Record<string, string> => {
  const o: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k) o[k] = r.value;
  }
  return o;
};

// Common bunqueue env knobs, offered as one-click add buttons.
const PRESETS = ['AUTH_TOKENS', 'LOG_LEVEL', 'S3_BACKUP_ENABLED', 'S3_BUCKET', 'METRICS_ENABLED'];

/**
 * Key/value editor for `ServerConfig.extraEnv`. The agent injects these into the
 * bunqueue process's environment on the next start/restart, on top of the
 * HTTP_PORT / TCP_PORT / BUNQUEUE_DATA_PATH it always sets.
 */
export function EnvVarsEditor({
  value,
  onChange,
  disabled,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled?: boolean;
}) {
  // Seeded once from the parent config; edits flow straight back up via onChange.
  const [rows, setRows] = useState<Row[]>(() => rowsFromObj(value));

  const commit = (next: Row[]) => {
    setRows(next);
    onChange(objFromRows(next));
  };
  const setRow = (id: number, patch: Partial<Row>) =>
    commit(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addRow = (key = '') => commit([...rows, { id: nextId++, key, value: '' }]);
  const removeRow = (id: number) => commit(rows.filter((r) => r.id !== id));

  const used = new Set(rows.map((r) => r.key.trim()).filter(Boolean));
  const dupes = rows.map((r) => r.key.trim()).filter((k, i, a) => k && a.indexOf(k) !== i);

  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 && (
        <p className="text-xs leading-relaxed text-faint">
          No custom variables. The agent already injects{' '}
          <code className="rounded bg-surface-2 px-1 py-0.5">HTTP_PORT</code>,{' '}
          <code className="rounded bg-surface-2 px-1 py-0.5">TCP_PORT</code> and{' '}
          <code className="rounded bg-surface-2 px-1 py-0.5">BUNQUEUE_DATA_PATH</code>.
        </p>
      )}
      {rows.map((r) => (
        <div key={r.id} className="flex items-center gap-2">
          <Input
            className="w-2/5 font-mono"
            placeholder="KEY"
            value={r.key}
            disabled={disabled}
            onChange={(e) => setRow(r.id, { key: e.target.value })}
          />
          <span className="text-faint">=</span>
          <Input
            className="flex-1 font-mono"
            placeholder="value"
            value={r.value}
            disabled={disabled}
            onChange={(e) => setRow(r.id, { value: e.target.value })}
          />
          <button
            type="button"
            aria-label={`Remove ${r.key || 'variable'}`}
            disabled={disabled}
            onClick={() => removeRow(r.id)}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-faint transition-colors hover:text-danger disabled:opacity-40"
          >
            ✕
          </button>
        </div>
      ))}

      {dupes.length > 0 && (
        <p className="text-xs text-warning">
          Duplicate key{dupes.length > 1 ? 's' : ''} — the last value wins: {dupes.join(', ')}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => addRow()}>
          + Add variable
        </Button>
        {PRESETS.filter((p) => !used.has(p)).map((p) => (
          <button
            key={p}
            type="button"
            disabled={disabled}
            onClick={() => addRow(p)}
            className="rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-[11px] text-muted transition-colors hover:border-line-strong hover:text-fg disabled:opacity-40"
          >
            + {p}
          </button>
        ))}
      </div>
    </div>
  );
}
