import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, Select, Toggle } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/PageHeader';
import { type AddJobBody, type Backoff, bq } from '@/lib/bq';
import type { CloneJobState } from '@/lib/cloneJob';
import { usePolledData } from '@/lib/usePolledData';

const numOrEmpty = (v: number | undefined): string => (v == null ? '' : String(v));

export function AddJob() {
  // Queue name datalist only — rarely changes, so slow-poll it.
  const { data: qs } = usePolledData(() => bq.queues(), [], { intervalMs: 30000 });

  // A "Clone" link from the Job Inspector hands us a source job's queue/data/
  // options via router state, so this form opens pre-filled for a fresh enqueue.
  const clone = (useLocation().state as Partial<CloneJobState> | null)?.clone;
  const opts = clone?.options ?? {};

  const [queue, setQueue] = useState(clone?.queue ?? '');
  const [dataText, setDataText] = useState(clone?.dataText ?? '{\n  "hello": "world"\n}');
  const [count, setCount] = useState('1');

  const [priority, setPriority] = useState(numOrEmpty(opts.priority));
  const [delay, setDelay] = useState('');
  const [runAt, setRunAt] = useState('');
  const [maxAttempts, setMaxAttempts] = useState(numOrEmpty(opts.maxAttempts));
  const [backoff, setBackoff] = useState(
    numOrEmpty(typeof opts.backoff === 'number' ? opts.backoff : undefined)
  );
  const [timeout, setTimeout] = useState(numOrEmpty(opts.timeout));
  const [jobId, setJobId] = useState('');
  const [removeOnComplete, setRemoveOnComplete] = useState(opts.removeOnComplete ?? false);
  const [removeOnFail, setRemoveOnFail] = useState(opts.removeOnFail ?? false);
  const [durable, setDurable] = useState(false);
  const [lifo, setLifo] = useState(false);
  // Advanced (honored by the single-push HTTP route).
  const [backoffType, setBackoffType] = useState<'' | 'fixed' | 'exponential'>('');
  const [tags, setTags] = useState('');
  const [groupId, setGroupId] = useState('');
  const [dependsOn, setDependsOn] = useState('');
  const [uniqueKey, setUniqueKey] = useState('');

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [jsonErr, setJsonErr] = useState<string | null>(null);

  const num = (s: string): number | undefined => {
    const n = Number(s);
    return s.trim() !== '' && Number.isFinite(n) ? n : undefined;
  };

  const submit = async () => {
    setResult(null);
    setJsonErr(null);
    if (!queue.trim()) {
      setResult({ ok: false, msg: 'Choose a queue' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataText);
    } catch (e) {
      setJsonErr(`Invalid JSON: ${(e as Error).message}`);
      return;
    }
    // "Run at" (absolute wall-clock) wins over the raw "Delay (ms)" field: derive
    // the relative delay the API actually takes from the picked datetime.
    let effectiveDelay = num(delay);
    if (runAt.trim()) {
      const targetMs = new Date(runAt).getTime();
      if (!Number.isFinite(targetMs)) {
        setResult({ ok: false, msg: 'Run at is not a valid date/time' });
        return;
      }
      effectiveDelay = Math.max(0, targetMs - Date.now());
    }
    const backoffNum = num(backoff);
    const backoff_: Backoff | undefined =
      backoffNum == null
        ? undefined
        : backoffType
          ? { type: backoffType, delay: backoffNum }
          : backoffNum;
    const tagList = tags
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const depList = dependsOn
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const body: AddJobBody = {
      data: parsed,
      priority: num(priority),
      delay: effectiveDelay,
      maxAttempts: num(maxAttempts),
      backoff: backoff_,
      timeout: num(timeout),
      jobId: jobId.trim() || undefined,
      removeOnComplete: removeOnComplete || undefined,
      removeOnFail: removeOnFail || undefined,
      durable: durable || undefined,
      lifo: lifo || undefined,
      tags: tagList.length ? tagList : undefined,
      groupId: groupId.trim() || undefined,
      dependsOn: depList.length ? depList : undefined,
      uniqueKey: uniqueKey.trim() || undefined,
    };
    const n = num(count) ?? 1;
    if (!Number.isInteger(n) || n < 1) {
      setResult({ ok: false, msg: 'Count must be an integer of at least 1' });
      return;
    }
    if (n > 10000) {
      setResult({ ok: false, msg: 'Count must be 10000 or fewer' });
      return;
    }
    setBusy(true);
    try {
      if (n === 1) {
        const r = await bq.addJob(queue, body);
        setResult({ ok: true, msg: `Created job ${r.id}` });
        toast.success('Job created', `${queue} · ${r.id}`);
      } else {
        const r = await bq.addJobsBulk(
          queue,
          Array.from({ length: n }, () => body)
        );
        // A shared custom jobId collapses N requests into one job — report the
        // distinct ids the server actually created, not the requested count.
        const created = new Set(r.ids).size;
        setResult({ ok: true, msg: `Created ${created} job${created === 1 ? '' : 's'}` });
        toast.success(`Created ${created} job${created === 1 ? '' : 's'}`, `in ${queue}`);
      }
    } catch (e) {
      setResult({ ok: false, msg: (e as Error).message });
      toast.error('Add job failed', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Add Job"
        description="Enqueue a job with full options."
        actions={
          <Link
            to="/jobs/bulk-add"
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
          >
            Bulk import
          </Link>
        }
      />

      {clone && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/[0.06] px-4 py-2 text-sm text-accent">
          Pre-filled from an existing job. Review the data and options, then enqueue a fresh job.
        </div>
      )}

      <form
        className="grid grid-cols-1 gap-6 lg:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Card>
          <CardHeader title="Job" />
          <div className="flex flex-col gap-4">
            <Field label="Queue">
              <Input
                list="queue-options"
                value={queue}
                onChange={(e) => setQueue(e.target.value)}
                placeholder="queue name (existing or new)"
              />
              <datalist id="queue-options">
                {(qs?.queues ?? []).map((x) => (
                  <option key={x.name} value={x.name} />
                ))}
              </datalist>
            </Field>
            <div>
              <Field label="Data (JSON)">
                <textarea
                  value={dataText}
                  onChange={(e) => setDataText(e.target.value)}
                  onBlur={() => {
                    // Validate on blur so a typo surfaces while the field is
                    // still in view, not only after Submit.
                    try {
                      JSON.parse(dataText);
                      setJsonErr(null);
                    } catch (e) {
                      setJsonErr(`Invalid JSON: ${(e as Error).message}`);
                    }
                  }}
                  spellCheck={false}
                  rows={7}
                  className="w-full rounded-lg border border-line bg-surface-2 p-3 font-mono text-sm text-fg focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </Field>
              {jsonErr && <p className="mt-2 text-xs text-danger">{jsonErr}</p>}
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Options" />
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <Field label="Priority">
              <Input
                type="number"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                placeholder="0"
              />
            </Field>
            <Field label="Delay (ms)">
              <Input
                type="number"
                min={0}
                value={delay}
                onChange={(e) => setDelay(e.target.value)}
                placeholder="0"
                disabled={runAt.trim() !== ''}
              />
            </Field>
            <Field
              label="Run at"
              hint={
                runAt.trim()
                  ? 'Overrides Delay — derived from this time (local time).'
                  : '(local time)'
              }
            >
              <Input
                type="datetime-local"
                value={runAt}
                onChange={(e) => setRunAt(e.target.value)}
              />
            </Field>
            <Field label="Max attempts" hint="blank = server default">
              <Input
                type="number"
                min={1}
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(e.target.value)}
                placeholder="3"
              />
            </Field>
            <Field label="Backoff (ms)" hint="blank = server default">
              <Input
                type="number"
                min={0}
                value={backoff}
                onChange={(e) => setBackoff(e.target.value)}
                placeholder="1000"
              />
            </Field>
            <Field label="Backoff strategy" hint="flat delay unless set">
              <Select
                value={backoffType}
                onChange={(e) => setBackoffType(e.target.value as '' | 'fixed' | 'exponential')}
              >
                <option value="">flat</option>
                <option value="fixed">fixed</option>
                <option value="exponential">exponential</option>
              </Select>
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
            <Field label="Custom job ID">
              <Input
                value={jobId}
                onChange={(e) => setJobId(e.target.value)}
                placeholder="idempotency key"
              />
            </Field>
          </div>
          <div className="mt-4 flex flex-wrap gap-6">
            <ToggleRow
              label="removeOnComplete"
              checked={removeOnComplete}
              onChange={setRemoveOnComplete}
            />
            <ToggleRow label="removeOnFail" checked={removeOnFail} onChange={setRemoveOnFail} />
            <ToggleRow label="durable" checked={durable} onChange={setDurable} />
            <ToggleRow label="lifo" checked={lifo} onChange={setLifo} />
          </div>

          <div className="mt-4 border-t border-line pt-4">
            <div className="mb-3 text-[11px] uppercase tracking-wider text-faint">Advanced</div>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
              <Field label="Tags" hint="comma-separated">
                <Input
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="email, urgent"
                />
              </Field>
              <Field label="Group ID">
                <Input
                  value={groupId}
                  onChange={(e) => setGroupId(e.target.value)}
                  placeholder="—"
                />
              </Field>
              <Field label="Unique key" hint="dedup key">
                <Input
                  value={uniqueKey}
                  onChange={(e) => setUniqueKey(e.target.value)}
                  placeholder="—"
                />
              </Field>
              <Field label="Depends on" hint="parent job ids, comma-separated">
                <Input
                  value={dependsOn}
                  onChange={(e) => setDependsOn(e.target.value)}
                  placeholder="job-id-1, job-id-2"
                />
              </Field>
            </div>
          </div>
        </Card>

        <div className="flex flex-wrap items-end gap-3 lg:col-span-2">
          <div className="w-28">
            <Field label="Count" hint="1–10000">
              <Input
                type="number"
                min={1}
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </Field>
          </div>
          <Button type="submit" variant="accent" disabled={busy}>
            {busy ? 'Adding…' : 'Add job'}
          </Button>
          {result && (
            <span
              role="status"
              className={result.ok ? 'text-sm text-success' : 'text-sm text-danger'}
            >
              {result.msg}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Toggle checked={checked} onChange={onChange} label={label} />
      <span className="font-mono text-xs text-muted">{label}</span>
    </div>
  );
}
