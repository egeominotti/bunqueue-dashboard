import { type ChangeEvent, useMemo, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, SegmentedControl } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/PageHeader';
import { type AddJobBody, bq } from '@/lib/bq';
import { usePolledData } from '@/lib/usePolledData';

const MAX_JOBS = 10000;
/** How each parsed item is interpreted (see coerceBody). */
type ParseMode = 'spec' | 'raw';

const SAMPLE = `[
  { "data": { "to": "a@example.com", "template": "welcome" }, "priority": 1 },
  { "data": { "to": "b@example.com", "template": "welcome" } }
]`;

const numDefault = (s: string): number | undefined => {
  const n = Number(s);
  return s.trim() !== '' && Number.isFinite(n) ? n : undefined;
};

const asNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const asBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const asStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;

interface Defaults {
  priority?: number;
  maxAttempts?: number;
  backoff?: number;
  timeout?: number;
}

/**
 * Turn one parsed element into an AddJobBody.
 * - `raw`  : the element IS the job's data, verbatim (never reinterpreted). Use
 *            this when your records happen to carry a `data`/`priority` column of
 *            their own that must be preserved.
 * - `spec` : an object with a `data` key is a full job spec ({ data, priority,
 *            delay, … }); anything else is treated as the job's data. Sibling keys
 *            outside the known option set are DROPPED, so only use it for records
 *            you authored as job specs.
 * Shared defaults fill option fields a spec omits.
 */
function coerceBody(el: unknown, def: Defaults, mode: ParseMode): AddJobBody {
  if (mode === 'spec' && el && typeof el === 'object' && !Array.isArray(el) && 'data' in el) {
    const o = el as Record<string, unknown>;
    return {
      data: o.data,
      priority: asNum(o.priority) ?? def.priority,
      delay: asNum(o.delay),
      maxAttempts: asNum(o.maxAttempts) ?? def.maxAttempts,
      backoff: asNum(o.backoff) ?? def.backoff,
      timeout: asNum(o.timeout) ?? def.timeout,
      jobId: asStr(o.jobId),
      removeOnComplete: asBool(o.removeOnComplete),
      removeOnFail: asBool(o.removeOnFail),
      durable: asBool(o.durable),
      lifo: asBool(o.lifo),
      ttl: asNum(o.ttl),
      uniqueKey: asStr(o.uniqueKey),
    };
  }
  return { data: el, ...def };
}

/** True when a `spec`-mode item carries keys that would be silently dropped. */
const SPEC_KEYS = new Set([
  'data',
  'priority',
  'delay',
  'maxAttempts',
  'backoff',
  'timeout',
  'jobId',
  'removeOnComplete',
  'removeOnFail',
  'durable',
  'lifo',
  'ttl',
  'uniqueKey',
]);
function specWouldDropKeys(items: unknown[]): boolean {
  return items.some(
    (el) =>
      el != null &&
      typeof el === 'object' &&
      !Array.isArray(el) &&
      'data' in el &&
      Object.keys(el as Record<string, unknown>).some((k) => !SPEC_KEYS.has(k))
  );
}

/** Parse the textarea as a JSON array, a single JSON object, or NDJSON (one per line). */
function parseInput(text: string): { items: unknown[]; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed) return { items: [], error: null };
  // Try whole-document JSON first (array or single object).
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return { items: parsed, error: null };
    return { items: [parsed], error: null };
  } catch {
    /* fall through to NDJSON */
  }
  // NDJSON: one JSON value per non-empty line.
  const items: unknown[] = [];
  const lines = trimmed.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      items.push(JSON.parse(line));
    } catch (e) {
      return { items: [], error: `Line ${i + 1}: ${(e as Error).message}` };
    }
  }
  return { items, error: null };
}

/**
 * Bulk-import distinct jobs from a pasted JSON array / NDJSON / uploaded file, in a
 * single `POST /queues/:q/jobs/bulk` call. Complements Add Job, whose Count field
 * only replicates one identical payload; this is for seeding or replaying a batch
 * of *different* payloads (e.g. re-importing many order records).
 */
export function BulkAddJobs() {
  const { data: qs } = usePolledData(() => bq.queues(), [], { intervalMs: 30000 });
  const [queue, setQueue] = useState('');
  const [text, setText] = useState('');
  const [mode, setMode] = useState<ParseMode>('spec');
  const [priority, setPriority] = useState('');
  const [maxAttempts, setMaxAttempts] = useState('');
  const [backoff, setBackoff] = useState('');
  const [timeout, setTimeout] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const { items, error } = useMemo(() => parseInput(text), [text]);
  // Warn (don't block) when spec-mode would silently drop non-option keys — the
  // signal that the operator probably wants raw mode for these records.
  const dropWarning = mode === 'spec' && !error && specWouldDropKeys(items);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Loading a file replaces the textarea wholesale — don't silently blow away
    // something the operator already pasted or edited.
    if (text.trim() !== '' && !window.confirm(`Replace the current input with "${file.name}"?`)) {
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ''));
    reader.onerror = () => setResult({ ok: false, msg: 'Could not read file' });
    reader.readAsText(file);
    // Reset so re-selecting the same file fires change again.
    e.target.value = '';
  };

  const submit = async () => {
    setResult(null);
    if (!queue.trim()) {
      setResult({ ok: false, msg: 'Choose a queue' });
      return;
    }
    if (error) {
      setResult({ ok: false, msg: error });
      return;
    }
    if (items.length === 0) {
      setResult({ ok: false, msg: 'Nothing to enqueue — paste a JSON array or NDJSON.' });
      return;
    }
    if (items.length > MAX_JOBS) {
      setResult({ ok: false, msg: `Too many jobs (${items.length}). Limit is ${MAX_JOBS}.` });
      return;
    }
    // maxAttempts/backoff/timeout are durations/counts — negative values are
    // never meaningful, so clamp to 0. Priority is left alone: lower/negative
    // priority is a valid server concept.
    const nonNeg = (n: number | undefined) => (n != null && n < 0 ? 0 : n);
    const def: Defaults = {
      priority: numDefault(priority),
      maxAttempts: nonNeg(numDefault(maxAttempts)),
      backoff: nonNeg(numDefault(backoff)),
      timeout: nonNeg(numDefault(timeout)),
    };
    const bodies = items.map((el) => coerceBody(el, def, mode));
    setBusy(true);
    try {
      const r = await bq.addJobsBulk(queue, bodies);
      // A shared custom jobId dedupes to one job server-side, so report distinct ids.
      const created = new Set(r.ids).size;
      const text2 = `Created ${created} job${created === 1 ? '' : 's'} in ${queue}`;
      setResult({ ok: true, msg: text2 });
      toast.success(text2);
    } catch (e) {
      const m = (e as Error).message;
      setResult({ ok: false, msg: m });
      toast.error('Bulk import failed', m);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Bulk Add Jobs"
        description="Import many distinct jobs at once from a JSON array, NDJSON, or a file."
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Jobs"
            action={
              <label className="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg">
                Upload file
                <input
                  type="file"
                  accept=".json,.ndjson,.txt,application/json"
                  onChange={onFile}
                  className="hidden"
                />
              </label>
            }
          />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            rows={16}
            placeholder={SAMPLE}
            aria-label="Jobs JSON"
            className="w-full rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium text-faint">Interpret each item as</span>
            <SegmentedControl options={['spec', 'raw'] as const} value={mode} onChange={setMode} />
            <span className="text-xs text-faint">
              {mode === 'spec'
                ? 'job spec: an object with a "data" key sets options from its sibling fields.'
                : 'raw data: the whole item becomes the job payload, untouched.'}
            </span>
          </div>
          <p className="mt-2 text-xs text-faint">
            Accepts a JSON array, a single object, or newline-delimited JSON.
          </p>
          <div className="mt-2 text-sm">
            {error ? (
              <span className="text-danger">{error}</span>
            ) : items.length > 0 ? (
              <span className="text-success">{items.length} job(s) parsed ✓</span>
            ) : (
              <span className="text-faint">Nothing parsed yet.</span>
            )}
          </div>
          {dropWarning && (
            <p className="mt-2 text-xs text-warning">
              Some items carry keys beyond the known job options — in “spec” mode those keys are
              dropped. Switch to “raw” to keep every field as the job's data.
            </p>
          )}
        </Card>

        <Card>
          <CardHeader title="Target & defaults" />
          <div className="flex flex-col gap-4">
            <Field label="Queue">
              <Input
                list="bulk-queue-options"
                value={queue}
                onChange={(e) => setQueue(e.target.value)}
                placeholder="queue name (existing or new)"
              />
              <datalist id="bulk-queue-options">
                {(qs?.queues ?? []).map((x) => (
                  <option key={x.name} value={x.name} />
                ))}
              </datalist>
            </Field>
            <p className="-mt-2 text-xs text-faint">Defaults below fill any field an item omits.</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Priority">
                <Input
                  type="number"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  placeholder="0"
                />
              </Field>
              <Field label="Max attempts">
                <Input
                  type="number"
                  min={0}
                  value={maxAttempts}
                  onChange={(e) => setMaxAttempts(e.target.value)}
                  placeholder="3"
                />
              </Field>
              <Field label="Backoff (ms)">
                <Input
                  type="number"
                  min={0}
                  value={backoff}
                  onChange={(e) => setBackoff(e.target.value)}
                  placeholder="1000"
                />
              </Field>
              <Field label="Timeout (ms)">
                <Input
                  type="number"
                  min={0}
                  value={timeout}
                  onChange={(e) => setTimeout(e.target.value)}
                  placeholder="—"
                />
              </Field>
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="accent"
                disabled={busy || items.length === 0 || error != null}
                onClick={submit}
              >
                {busy ? 'Importing…' : `Import ${items.length || ''}`}
              </Button>
            </div>
            {result && (
              <span
                role="status"
                className={result.ok ? 'text-sm text-success' : 'text-sm text-danger'}
              >
                {result.msg}
              </span>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
