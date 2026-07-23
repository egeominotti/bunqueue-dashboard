import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/form';
import { bq } from '@/lib/bq';

type LogLevel = 'info' | 'warn' | 'error';

/**
 * Job logs viewer + writer. Reads `GET /jobs/:id/logs` (bq.jobLogs), appends
 * lines via `POST /jobs/:id/logs` (bq.addJobLog) and wipes them via
 * `DELETE /jobs/:id/logs` (bq.clearJobLogs). Every mutation reloads the list so
 * the view never drifts from the server.
 */
export function JobLogs({ jobId }: { jobId: string }) {
  const [logs, setLogs] = useState<unknown[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [level, setLevel] = useState<LogLevel>('info');
  const [busy, setBusy] = useState(false);

  // Sequence guard (last-to-start wins): add() reloads while a slow mount read
  // may still be in flight, and that older snapshot — taken before the POST —
  // would otherwise land last and erase the line just added.
  const gen = useRef(0);

  const load = useCallback(async () => {
    const my = ++gen.current;
    setLoading(true);
    setError(null);
    try {
      const r = await bq.jobLogs(jobId);
      if (my !== gen.current) return;
      setLogs(r.data?.logs ?? []);
      setCount(r.data?.count ?? 0);
    } catch (e) {
      if (my === gen.current) setError((e as Error).message);
    } finally {
      if (my === gen.current) setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    if (busy) return; // Enter auto-repeat would double-post the same line
    const text = message.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      await bq.addJobLog(jobId, text, level);
      setMessage('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!window.confirm('Clear all logs for this job?')) return;
    setBusy(true);
    setError(null);
    try {
      await bq.clearJobLogs(jobId);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Logs"
        action={
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-faint">{count}</span>
            <Button size="sm" variant="ghost" disabled={loading || busy} onClick={load}>
              Refresh
            </Button>
            <Button size="sm" variant="danger" disabled={busy || logs.length === 0} onClick={clear}>
              Clear logs
            </Button>
          </div>
        }
      />
      {error && <p className="mb-2 text-xs text-danger">{error}</p>}
      {logs.length === 0 ? (
        <p className="text-xs text-faint">No log lines recorded for this job.</p>
      ) : (
        <ol className="flex max-h-64 flex-col gap-1 overflow-auto rounded-lg bg-surface-2 p-3">
          {logs.map((line, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only server log, stable order
              key={i}
              className="whitespace-pre-wrap break-words font-mono text-xs text-muted"
            >
              {typeof line === 'string' ? line : JSON.stringify(line)}
            </li>
          ))}
        </ol>
      )}
      <div className="mt-3 flex gap-2">
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="Add a log line…"
          className="h-8 flex-1 text-xs"
        />
        <Select
          value={level}
          onChange={(e) => setLevel(e.target.value as LogLevel)}
          className="h-8 w-24 text-xs"
        >
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </Select>
        <Button size="sm" disabled={busy || message.trim() === ''} onClick={add}>
          Add
        </Button>
      </div>
    </Card>
  );
}
