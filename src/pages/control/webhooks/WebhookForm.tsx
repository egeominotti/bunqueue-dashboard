import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/form';
import { type AddWebhookBody, WEBHOOK_EVENTS } from '@/lib/bq';
import {
  assertSuccessfulMutationResponse,
  type ServerActionLease,
} from '@/lib/useServerActionGuard';
import { buildWebhookBody } from './model';

export function WebhookForm({
  onAdd,
  onAccepted,
  beginAdd,
  scopeKey,
}: {
  onAdd: (body: AddWebhookBody) => Promise<unknown>;
  onAccepted: () => void;
  beginAdd: () => ServerActionLease | null;
  scopeKey: string;
}) {
  const [url, setUrl] = useState('');
  const [queue, setQueue] = useState('');
  const [secret, setSecret] = useState('');
  const [events, setEvents] = useState<string[]>(['job.completed', 'job.failed']);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // scopeKey is the connection lifecycle boundary.
  useEffect(() => {
    setBusy(false);
    setErr(null);
  }, [scopeKey]);

  const toggle = (event: string) =>
    setEvents((current) =>
      current.includes(event) ? current.filter((item) => item !== event) : [...current, event]
    );

  const submit = async () => {
    if (busy) return;
    setErr(null);
    const built = buildWebhookBody(url, events, queue, secret);
    if (!built.ok) return setErr(built.msg);
    const lease = beginAdd();
    if (!lease) return;
    setBusy(true);
    try {
      const response = await onAdd(built.body);
      assertSuccessfulMutationResponse(response, 'Add webhook');
      if (!lease.isCurrent()) return;
      setUrl('');
      setSecret('');
      onAccepted();
    } catch (error) {
      if (lease.isCurrent()) setErr((error as Error).message);
    } finally {
      if (lease.finish()) setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="md:col-span-1">
          <Field label="URL">
            <Input
              value={url}
              onInput={(event) => setUrl(event.currentTarget.value)}
              name="webhook-url"
              type="url"
              maxLength={2_048}
              autoComplete="url"
              placeholder="https://example.com/hook"
            />
          </Field>
        </div>
        <Field label="Queue (optional)">
          <Input
            value={queue}
            onChange={(event) => setQueue(event.target.value)}
            name="webhook-queue"
            maxLength={256}
            autoComplete="off"
            placeholder="all queues"
          />
        </Field>
        <Field label="Secret (optional)">
          <Input
            type="password"
            autoComplete="new-password"
            name="webhook-secret"
            maxLength={65_536}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder="HMAC signing secret"
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        {WEBHOOK_EVENTS.map((event) => (
          <button
            key={event}
            type="button"
            aria-pressed={events.includes(event)}
            onClick={() => toggle(event)}
            className={
              events.includes(event)
                ? 'rounded-full bg-accent/15 px-3 py-1 text-xs font-medium text-accent'
                : 'rounded-full border border-line px-3 py-1 text-xs font-medium text-muted hover:text-fg'
            }
          >
            {event}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="accent" size="sm" disabled={busy}>
          {busy ? 'Adding…' : 'Add webhook'}
        </Button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </form>
  );
}
