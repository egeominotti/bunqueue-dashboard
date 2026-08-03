import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePolledData } from '@/lib/usePolledData';

type ConnectionState = 'connecting' | 'connected' | 'degraded' | 'offline';

const STATE_META: Record<ConnectionState, { dot: string; label: string }> = {
  connecting: { dot: 'bg-zinc-500', label: 'connecting' },
  connected: { dot: 'bg-emerald-400', label: 'connected' },
  degraded: { dot: 'bg-amber-400', label: 'reachable, degraded' },
  offline: { dot: 'bg-red-400', label: 'offline' },
};

/** Passive, honest health indicator shared by desktop and mobile navigation. */
export function ConnectionBadge() {
  const baseUrl = useConnectionStore((s) => s.baseUrl);
  // /health returns HTTP 503 with `ok:false` when the server is reachable but
  // degraded (for example, disk full). That differs from a transport failure.
  const { data, error, loading } = usePolledData(
    async () => {
      const health = await api.health();
      if (typeof health.ok !== 'boolean') throw new Error('Malformed health response');
      return { healthy: health.ok };
    },
    [],
    { intervalMs: 15000 }
  );
  const state: ConnectionState = loading
    ? 'connecting'
    : error || !data
      ? 'offline'
      : data.healthy
        ? 'connected'
        : 'degraded';
  const meta = STATE_META[state];
  const host = baseUrl.replace(/^https?:\/\//, '') || 'local';

  return (
    <div className="mx-3 mb-4 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5">
      <span className={cn('size-1.5 rounded-full', meta.dot)} title={meta.label} />
      <span className="truncate font-mono text-[11px] text-muted" title={baseUrl}>
        {host}
      </span>
      <span className="sr-only">{meta.label}</span>
    </div>
  );
}
