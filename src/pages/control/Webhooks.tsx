import { useState } from 'react';
import { Button, IconButton } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Field, Input, Toggle } from '@/components/ui/form';
import { IconLightning, IconTrash } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { type AddWebhookBody, bq, WEBHOOK_EVENTS } from '@/lib/bq';
import { formatNumber, formatRelativeTime } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';

export function Webhooks() {
  const { data, error, loading, refetch } = usePolledData(() => bq.webhooks(), []);
  const webhooks = data?.data?.webhooks ?? [];
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 15;
  const pageCount = Math.max(1, Math.ceil(webhooks.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);

  const [actErr, setActErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setActErr(null);
    try {
      await fn();
      refetch();
    } catch (e) {
      // Surface the failure — a silently-snapping-back toggle or a no-op
      // confirmed delete otherwise reads as "it worked".
      setActErr((e as Error).message);
    }
  };

  return (
    <div>
      <PageHeader title="Webhooks" description="HTTP callbacks fired on job events." live />

      {error && <OfflineBanner onRetry={refetch} />}
      {actErr && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2 text-sm text-danger">
          {actErr}
        </div>
      )}

      <Card className="mb-6">
        <CardHeader title="Add webhook" />
        <WebhookForm
          onAdd={async (b) => {
            await bq.addWebhook(b);
            refetch();
          }}
        />
      </Card>

      {loading && !data && !error ? (
        <LoadingState label="Loading webhooks…" />
      ) : webhooks.length === 0 ? (
        <EmptyState
          icon={<IconLightning />}
          title="No webhooks"
          hint="Add one above to receive job-event callbacks."
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                  <th className="px-5 py-3 font-medium">URL</th>
                  <th className="px-5 py-3 font-medium">Events</th>
                  <th className="px-5 py-3 font-medium">Queue</th>
                  <th className="px-5 py-3 text-right font-medium">Success / Fail</th>
                  <th className="px-5 py-3 text-right font-medium">Last</th>
                  <th className="px-5 py-3 font-medium">Enabled</th>
                  <th className="w-12 px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {webhooks.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE).map((w) => (
                  <tr
                    key={w.id}
                    className="border-b border-line last:border-0 align-top hover:bg-surface-2/40"
                  >
                    <td className="max-w-xs truncate px-5 py-3 font-mono text-xs text-fg">
                      {w.url}
                    </td>
                    <td className="px-5 py-3 text-xs text-muted">{w.events.join(', ')}</td>
                    <td className="px-5 py-3 font-mono text-xs text-muted">{w.queue ?? 'all'}</td>
                    <td className="px-5 py-3 text-right tnum text-muted">
                      <span className="text-success">{formatNumber(w.successCount)}</span>
                      {' / '}
                      <span className={w.failureCount ? 'text-danger' : ''}>
                        {formatNumber(w.failureCount)}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right text-faint">
                      {formatRelativeTime(w.lastTriggered)}
                    </td>
                    <td className="px-5 py-3">
                      <Toggle
                        checked={w.enabled}
                        label={`${w.enabled ? 'Disable' : 'Enable'} webhook`}
                        onChange={(v) => act(() => bq.setWebhookEnabled(w.id, v))}
                      />
                    </td>
                    <td className="px-5 py-3 text-right">
                      <IconButton
                        aria-label="Remove webhook"
                        onClick={() =>
                          window.confirm(`Remove webhook for ${w.url}?`) &&
                          act(() => bq.removeWebhook(w.id))
                        }
                      >
                        <IconTrash className="size-3.5" />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={safePage}
            pageSize={PAGE_SIZE}
            total={webhooks.length}
            onPageChange={setPage}
            label="webhooks"
          />
        </>
      )}
    </div>
  );
}

function WebhookForm({ onAdd }: { onAdd: (b: AddWebhookBody) => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [queue, setQueue] = useState('');
  const [secret, setSecret] = useState('');
  const [events, setEvents] = useState<string[]>(['job.completed', 'job.failed']);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (ev: string) =>
    setEvents((prev) => (prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev]));

  const submit = async () => {
    if (busy) return; // a double-click would register the webhook twice
    setErr(null);
    if (!url.trim() || events.length === 0) {
      setErr('URL and at least one event are required');
      return;
    }
    setBusy(true);
    try {
      await onAdd({
        url,
        events,
        queue: queue.trim() || undefined,
        secret: secret.trim() || undefined,
      });
      setUrl('');
      setSecret('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="md:col-span-1">
          <Field label="URL">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/hook"
            />
          </Field>
        </div>
        <Field label="Queue (optional)">
          <Input
            value={queue}
            onChange={(e) => setQueue(e.target.value)}
            placeholder="all queues"
          />
        </Field>
        <Field label="Secret (optional)">
          <Input
            type="password"
            autoComplete="new-password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="HMAC signing secret"
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        {WEBHOOK_EVENTS.map((ev) => (
          <button
            key={ev}
            type="button"
            aria-pressed={events.includes(ev)}
            onClick={() => toggle(ev)}
            className={
              events.includes(ev)
                ? 'rounded-full bg-accent/15 px-3 py-1 text-xs font-medium text-accent'
                : 'rounded-full border border-line px-3 py-1 text-xs font-medium text-muted hover:text-fg'
            }
          >
            {ev}
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
