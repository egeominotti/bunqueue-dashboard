import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { IconPause, IconPlay, IconRefresh } from '@/components/ui/icons';
import type { ServerStatus } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatDateTime, formatUptime } from '@/lib/format';

interface Props {
  status: ServerStatus | null;
  agentBase: string;
  transitioning: boolean;
  busy: string | null;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
}

const STATE_META: Record<string, { label: string; tone: string; dot: string }> = {
  running: { label: 'Running', tone: 'text-emerald-400', dot: 'bg-emerald-400' },
  starting: { label: 'Starting', tone: 'text-amber-400', dot: 'bg-amber-400' },
  stopping: { label: 'Stopping', tone: 'text-amber-400', dot: 'bg-amber-400' },
  stopped: { label: 'Stopped', tone: 'text-red-400', dot: 'bg-red-400' },
};

/** Ticks once a second so the console reads live without re-rendering the page. */
function UptimeTicker({ startedAt }: { startedAt: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{formatUptime((Date.now() - startedAt) / 1000)}</>;
}

function Vital({
  label,
  children,
  title,
}: {
  label: string;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-faint">{label}</div>
      <div className="mt-0.5 truncate font-mono text-sm text-fg">{children}</div>
    </div>
  );
}

/**
 * Mission-control console for the bunqueue server process: live state readout,
 * power controls, and an instrument cluster of vitals — the page's focal point.
 */
export function StatusConsole({
  status,
  agentBase,
  transitioning,
  busy,
  onStart,
  onStop,
  onRestart,
}: Props) {
  const state = status?.status ?? 'stopped';
  const running = state === 'running';
  const meta = STATE_META[state] ?? STATE_META.stopped;
  const healthy = !!status?.healthy;
  const crashed = !running && status?.exitCode != null && status.exitCode !== 0;

  const cfg = status?.runningConfig ?? status?.config ?? null;
  const httpPort = cfg?.httpPort ?? 6790;
  const serverBase = `http://localhost:${httpPort}`;

  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-line bg-surface">
      {/* Signature hairline: the console's "power rail". */}
      <div
        className={cn(
          'h-0.5 bg-gradient-to-r to-transparent',
          running && healthy
            ? 'from-emerald-400/80 via-emerald-400/25'
            : running || transitioning
              ? 'from-amber-400/80 via-amber-400/25'
              : 'from-red-400/70 via-red-400/20'
        )}
      />
      <div className="flex flex-col gap-5 p-5 lg:flex-row lg:items-center lg:justify-between">
        {/* State readout */}
        <div className="flex items-center gap-4">
          <span className="relative flex size-3.5 shrink-0">
            {running && healthy && (
              <span className="absolute inline-flex size-full rounded-full bg-emerald-400 opacity-50 motion-safe:animate-ping" />
            )}
            <span className={cn('relative inline-flex size-3.5 rounded-full', meta.dot)} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className={cn('text-2xl font-bold tracking-tight', meta.tone)}>
                {transitioning && busy ? `${busy}…` : meta.label}
              </span>
              {status?.version && (
                <span className="font-mono text-xs text-muted">bunqueue v{status.version}</span>
              )}
              {crashed && (
                <span className="rounded-full bg-red-500/15 px-2 py-0.5 font-mono text-[11px] font-medium text-red-400">
                  crashed · exit {status?.exitCode}
                </span>
              )}
            </div>
            <div className="mt-1 font-mono text-xs text-muted">
              {running ? (
                <>
                  {healthy ? 'healthy' : 'waiting for health…'} · pid {status?.pid ?? '—'} · up{' '}
                  {status?.startedAt ? <UptimeTicker startedAt={status.startedAt} /> : '—'}
                </>
              ) : (
                'process not running — start it below or point the dashboard at an external server'
              )}
            </div>
          </div>
        </div>

        {/* Power controls */}
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="success" disabled={running || transitioning} onClick={onStart}>
            <IconPlay className="size-4" /> Start
          </Button>
          <Button variant="warning" disabled={!running || transitioning} onClick={onStop}>
            <IconPause className="size-4" /> Stop
          </Button>
          <Button disabled={transitioning} onClick={onRestart}>
            <IconRefresh className="size-4" /> Restart
          </Button>
        </div>
      </div>

      {/* Instrument cluster */}
      <div className="grid grid-cols-2 gap-4 border-t border-line bg-surface-2/30 px-5 py-4 md:grid-cols-3 xl:grid-cols-5">
        <Vital label="API endpoint" title={serverBase}>
          {running ? (
            <span className="flex items-center gap-1.5">
              <a
                href={`${serverBase}/health`}
                target="_blank"
                rel="noreferrer"
                className="truncate text-accent hover:underline"
              >
                {serverBase}
              </a>
              <CopyButton value={serverBase} />
            </span>
          ) : (
            <span className="text-faint">{serverBase}</span>
          )}
        </Vital>
        <Vital label="Ports">{cfg ? `${cfg.httpPort} http · ${cfg.tcpPort} tcp` : '—'}</Vital>
        <Vital label="Started">
          {running && status?.startedAt ? formatDateTime(status.startedAt) : '—'}
        </Vital>
        <Vital label="Control agent" title={agentBase}>
          {agentBase.replace(/^https?:\/\//, '')}
        </Vital>
        <Vital label="Launch command" title={cfg?.command}>
          {cfg?.command ?? '—'}
        </Vital>
      </div>
    </section>
  );
}
