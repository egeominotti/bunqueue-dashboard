import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, Toggle } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/PageHeader';
import { type AddJobBody, bq } from '@/lib/bq';
import { usePolledData } from '@/lib/usePolledData';

export function AddJob() {
  // Queue name datalist only — rarely changes, so slow-poll it.
  const { data: qs } = usePolledData(() => bq.queues(), [], { intervalMs: 30000 });
  const [queue, setQueue] = useState('');
  const [dataText, setDataText] = useState('{\n  "hello": "world"\n}');
  const [count, setCount] = useState('1');

  const [priority, setPriority] = useState('');
  const [delay, setDelay] = useState('');
  const [maxAttempts, setMaxAttempts] = useState('');
  const [backoff, setBackoff] = useState('');
  const [timeout, setTimeout] = useState('');
  const [jobId, setJobId] = useState('');
  const [removeOnComplete, setRemoveOnComplete] = useState(false);
  const [removeOnFail, setRemoveOnFail] = useState(false);
  const [durable, setDurable] = useState(false);
  const [lifo, setLifo] = useState(false);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const num = (s: string): number | undefined => {
    const n = Number(s);
    return s.trim() !== '' && Number.isFinite(n) ? n : undefined;
  };

  const submit = async () => {
    setResult(null);
    if (!queue.trim()) {
      setResult({ ok: false, msg: 'Choose a queue' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataText);
    } catch {
      setResult({ ok: false, msg: 'Data is not valid JSON' });
      return;
    }
    const body: AddJobBody = {
      data: parsed,
      priority: num(priority),
      delay: num(delay),
      maxAttempts: num(maxAttempts),
      backoff: num(backoff),
      timeout: num(timeout),
      jobId: jobId.trim() || undefined,
      removeOnComplete: removeOnComplete || undefined,
      removeOnFail: removeOnFail || undefined,
      durable: durable || undefined,
      lifo: lifo || undefined,
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
      } else {
        const r = await bq.addJobsBulk(
          queue,
          Array.from({ length: n }, () => body)
        );
        // A shared custom jobId collapses N requests into one job — report the
        // distinct ids the server actually created, not the requested count.
        const created = new Set(r.ids).size;
        setResult({ ok: true, msg: `Created ${created} job${created === 1 ? '' : 's'}` });
      }
    } catch (e) {
      setResult({ ok: false, msg: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="Add Job" description="Enqueue a job with full options." />

      <div className="grid max-w-3xl grid-cols-1 gap-6">
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
            <Field label="Data (JSON)">
              <textarea
                value={dataText}
                onChange={(e) => setDataText(e.target.value)}
                spellCheck={false}
                rows={7}
                className="w-full rounded-lg border border-line bg-surface-2 p-3 font-mono text-sm text-fg focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
            </Field>
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
                value={delay}
                onChange={(e) => setDelay(e.target.value)}
                placeholder="0"
              />
            </Field>
            <Field label="Max attempts">
              <Input
                type="number"
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(e.target.value)}
                placeholder="3"
              />
            </Field>
            <Field label="Backoff (ms)">
              <Input
                type="number"
                value={backoff}
                onChange={(e) => setBackoff(e.target.value)}
                placeholder="1000"
              />
            </Field>
            <Field label="Timeout (ms)">
              <Input
                type="number"
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
        </Card>

        <div className="flex items-center gap-3">
          <div className="w-28">
            <Field label="Count">
              <Input type="number" value={count} onChange={(e) => setCount(e.target.value)} />
            </Field>
          </div>
          <Button variant="accent" disabled={busy} onClick={submit} className="mt-5">
            {busy ? 'Adding…' : 'Add job'}
          </Button>
          {result && (
            <span
              className={result.ok ? 'mt-5 text-sm text-emerald-400' : 'mt-5 text-sm text-red-400'}
            >
              {result.msg}
            </span>
          )}
        </div>
      </div>
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
