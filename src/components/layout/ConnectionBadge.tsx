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
  const profiles = useConnectionStore((s) => s.profiles);
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const activateProfile = useConnectionStore((s) => s.activateProfile);
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
      <label className="sr-only" htmlFor="active-bunqueue-node">
        Active Bunqueue node
      </label>
      <select
        id="active-bunqueue-node"
        aria-label="Active Bunqueue node"
        value={activeProfileId}
        onChange={(event) => activateProfile(event.target.value)}
        title={`${profiles.length} configured node${profiles.length === 1 ? '' : 's'} · ${baseUrl}`}
        className="min-w-0 flex-1 truncate bg-transparent text-[11px] font-medium text-muted outline-none"
      >
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
      <span className="sr-only" title={baseUrl}>
        {host}
      </span>
      <span
        className="shrink-0 font-mono text-[10px] text-faint"
        aria-label={`${profiles.length} nodes`}
      >
        {profiles.length}×
      </span>
      <span className="sr-only">{meta.label}</span>
    </div>
  );
}
