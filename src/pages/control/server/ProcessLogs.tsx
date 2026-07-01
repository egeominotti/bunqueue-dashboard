import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { SegmentedControl } from '@/components/ui/form';
import { IconSearch } from '@/components/ui/icons';
import { bq } from '@/lib/bq';
import type { ServerLogLine } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { usePolledData } from '@/lib/usePolledData';

const STREAMS = ['all', 'stdout', 'stderr', 'sys'] as const;
type StreamFilter = (typeof STREAMS)[number];

const clock = (ts: number): string =>
  `${new Date(ts).toLocaleTimeString([], { hour12: false })}.${String(ts % 1000).padStart(3, '0')}`;

const toneFor = (stream: ServerLogLine['stream']): string =>
  stream === 'stderr' ? 'text-red-400/90' : stream === 'sys' ? 'text-accent/80' : 'text-muted';

/**
 * Live tail of the managed bunqueue process's stdout/stderr + agent system
 * messages, with stream filtering, text search, timestamps, a follow toggle,
 * and copy / download of exactly what's shown.
 */
export function ProcessLogs() {
  const { data } = usePolledLogs();
  const lines = useMemo(() => data?.lines ?? [], [data]);

  const [stream, setStream] = useState<StreamFilter>('all');
  const [search, setSearch] = useState('');
  const [follow, setFollow] = useState(true);
  const [showTimes, setShowTimes] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    return lines.filter(
      (l) =>
        (stream === 'all' || l.stream === stream) && (!term || l.line.toLowerCase().includes(term))
    );
  }, [lines, stream, search]);

  // Follow the tail only while enabled, so scrolling up to read isn't yanked back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the tail on new lines
  useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length, follow]);

  const asText = useMemo(
    () =>
      shown.map((l) => (showTimes ? `${clock(l.ts)} [${l.stream}] ${l.line}` : l.line)).join('\n'),
    [shown, showTimes]
  );

  const download = () => {
    const blob = new Blob([asText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bunqueue-logs-${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <h3 className="mr-1 text-base font-semibold text-fg">Process logs</h3>
        <SegmentedControl options={STREAMS} value={stream} onChange={setStream} />
        <div className="relative min-w-40 flex-1">
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter…"
            className="h-8 w-full rounded-lg border border-line bg-surface-2 pl-8 pr-2 text-xs text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>
        <Toggle on={follow} onClick={() => setFollow((v) => !v)} label="Follow" />
        <Toggle on={showTimes} onClick={() => setShowTimes((v) => !v)} label="Times" />
        <CopyButton value={asText} />
        <button
          type="button"
          onClick={download}
          disabled={shown.length === 0}
          className="rounded-md border border-line bg-surface-2 px-2 py-1 text-xs text-muted transition-colors hover:text-fg disabled:opacity-40"
        >
          Download
        </button>
      </div>

      <div
        ref={scrollRef}
        className="max-h-80 min-h-40 overflow-y-auto p-4 font-mono text-xs leading-relaxed"
      >
        {shown.length === 0 ? (
          <p className="text-faint">
            {lines.length === 0 ? 'No output yet.' : 'No lines match the current filter.'}
          </p>
        ) : (
          shown.map((l) => (
            <div key={l.seq} className={cn('whitespace-pre-wrap', toneFor(l.stream))}>
              {showTimes && <span className="mr-2 text-faint">{clock(l.ts)}</span>}
              {l.line}
            </div>
          ))
        )}
      </div>

      <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[11px] text-faint">
        <span>
          {shown.length === lines.length
            ? `${lines.length} lines`
            : `${shown.length} of ${lines.length} lines`}
        </span>
        <span>{follow ? 'following tail' : 'paused'}</span>
      </div>
    </Card>
  );
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        'rounded-md border px-2 py-1 text-xs transition-colors',
        on
          ? 'border-accent/40 bg-accent/10 text-accent'
          : 'border-line bg-surface-2 text-muted hover:text-fg'
      )}
    >
      {label}
    </button>
  );
}

// Local poll so the panel owns its own cadence without touching the page fetch.
function usePolledLogs() {
  return usePolledData(() => bq.control.logs(), []);
}
