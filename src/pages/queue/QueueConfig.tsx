import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/form';
import { IconLightning, IconWorkers } from '@/components/ui/icons';
import { api } from '@/lib/api';

/** Rate-limit + concurrency controls for a single queue (matches the reference "Configuration" block). */
export function QueueConfig({ queue }: { queue: string }) {
  return (
    <div className="mt-8">
      <h2 className="mb-3 text-lg font-semibold text-fg">Configuration</h2>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <RateLimitCard queue={queue} />
        <ConcurrencyCard queue={queue} />
      </div>
    </div>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await fn();
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, done, run };
}

function RateLimitCard({ queue }: { queue: string }) {
  const [max, setMax] = useState('');
  const { busy, error, done, run } = useAction();

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-fg">Rate Limit</h3>
        <IconLightning className="size-4 text-faint" />
      </div>
      <Field label="Max jobs / second">
        <Input
          type="number"
          inputMode="numeric"
          placeholder="100"
          value={max}
          onChange={(e) => setMax(e.target.value)}
        />
      </Field>
      <div className="mt-4 flex items-center gap-2">
        <Button
          variant="accent"
          size="sm"
          disabled={busy || !max}
          onClick={() => run(() => api.setRateLimit(queue, Number(max)))}
        >
          Set
        </Button>
        <Button size="sm" disabled={busy} onClick={() => run(() => api.clearRateLimit(queue))}>
          Clear
        </Button>
        {done && <span className="text-xs text-emerald-400">Saved</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </Card>
  );
}

function ConcurrencyCard({ queue }: { queue: string }) {
  const [concurrency, setConcurrency] = useState('');
  const { busy, error, done, run } = useAction();

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-fg">Concurrency</h3>
        <IconWorkers className="size-4 text-faint" />
      </div>
      <Field label="Concurrency">
        <Input
          type="number"
          inputMode="numeric"
          placeholder="5"
          value={concurrency}
          onChange={(e) => setConcurrency(e.target.value)}
        />
      </Field>
      <div className="mt-4 flex items-center gap-2">
        <Button
          variant="accent"
          size="sm"
          disabled={busy || !concurrency}
          onClick={() => run(() => api.setConcurrency(queue, Number(concurrency)))}
        >
          Set
        </Button>
        <Button size="sm" disabled={busy} onClick={() => run(() => api.clearConcurrency(queue))}>
          Clear
        </Button>
        {done && <span className="text-xs text-emerald-400">Saved</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </Card>
  );
}
