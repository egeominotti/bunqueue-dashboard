import { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { api } from './api';
import {
  frameIndicatesConnected,
  type SseFrame,
  shouldDiscardLastEventId,
  streamEvents,
} from './sse';
import type { ActivityEvent } from './types';

export interface ActivityCounters {
  total: number;
  completed: number;
  failed: number;
  waiting: number;
  active: number;
}

const EMPTY: ActivityCounters = { total: 0, completed: 0, failed: 0, waiting: 0, active: 0 };
const MAX_EVENTS = 250;

/**
 * Monotonic clock for the throughput window. Date.now() can step BACKWARDS
 * (NTP correction, resume from sleep, manual clock change); with a one-sided
 * `now - ts < 5000` prune every pre-step stamp then compares negative, so the
 * window stops pruning, `stamps` grows unbounded and the rate stays inflated.
 */
const monoNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown, maxChars: number): string | undefined {
  return typeof value === 'string' && value.length <= maxChars ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function validTimestamp(value: unknown, fallback: number): number {
  const timestamp = optionalFiniteNumber(value);
  if (timestamp !== undefined && Math.abs(timestamp) <= 8.64e15) return timestamp;
  return Number.isFinite(fallback) && Math.abs(fallback) <= 8.64e15 ? fallback : 0;
}

/** Normalize the untrusted JSON carried by a job SSE frame. */
function activityPayload(data: unknown): {
  queue?: string;
  jobId?: string;
  name?: string;
  timestamp: number;
  error?: string;
  progress?: number;
} {
  const record = isRecord(data) ? data : {};
  const wallNow = Date.now();
  return {
    queue: optionalString(record.queue, 256),
    jobId: optionalString(record.jobId, 1024),
    name: optionalString(record.name, 512),
    timestamp: validTimestamp(record.timestamp, wallNow),
    error: optionalString(record.error, 4096),
    progress: optionalFiniteNumber(record.progress),
  };
}

function statusFromEvent(event: string): string {
  const suffix = event.includes(':') ? event.split(':')[1] : event;
  switch (suffix) {
    case 'pushed':
    case 'added':
      return 'waiting';
    case 'pulled':
      return 'active';
    case 'progress':
      return 'active';
    default:
      return suffix;
  }
}

/**
 * Subscribe to the server's SSE activity stream and keep a bounded ring buffer
 * of recent job events plus cumulative counters and a rolling throughput.
 * Reconnects automatically when the connection target changes.
 */
export function useActivityStream(queue?: string) {
  const baseUrl = useConnectionStore((s) => s.baseUrl);
  const token = useConnectionStore((s) => s.token);

  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [counters, setCounters] = useState<ActivityCounters>(EMPTY);
  const [throughput, setThroughput] = useState(0);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const stamps = useRef<number[]>([]);
  // Each effect has a generation because custom fetch/streams may ignore abort.
  const streamGeneration = useRef(0);
  const targetKey = JSON.stringify([baseUrl, token, queue ?? null]);
  // A passive effect resets the stored stream state below, but it runs after
  // render. Gate the entire public snapshot too so a target switch cannot paint
  // one frame of server/queue A's data or Live status under selection B.
  const publishedTarget = useRef(targetKey);
  const targetMatches = publishedTarget.current === targetKey;
  const visibleEvents = targetMatches ? events : [];
  const visibleCounters = targetMatches ? counters : EMPTY;
  const visibleThroughput = targetMatches ? throughput : 0;
  const visibleConnected = targetMatches ? connected : false;
  const visibleError = targetMatches ? error : null;

  // baseUrl/token aren't read directly in the body (api.eventsUrl / getAuthHeaders
  // read them fresh at connect time) — they're deps so the stream tears down and
  // reconnects when the server URL or token changes in Settings. Removing them
  // (biome's "unnecessary" fix) would keep streaming from the stale server.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reconnect triggers
  useEffect(() => {
    const ctrl = new AbortController();
    const generation = ++streamGeneration.current;
    let seq = 0;
    let cancelled = false;
    // Buffers are generation-local; obsolete callbacks cannot publish into the replacement stream.
    let pendingEvents: ActivityEvent[] = [];
    let pendingCounters: ActivityCounters = { ...EMPTY };
    // Retain replay ids across reconnects, but never across queue/origin/token generations.
    let lastEventId: string | undefined;
    const isCurrent = () => !cancelled && streamGeneration.current === generation;

    publishedTarget.current = targetKey;
    setEvents([]);
    setCounters(EMPTY);
    setThroughput(0);
    setConnected(false);
    setError(null);
    stamps.current = [];

    // Abortable delay so a pending reconnect wait resolves immediately on
    // cleanup. The abort listener is removed on both paths so repeated
    // reconnects don't accumulate listeners on ctrl.signal.
    const delay = (ms: number) =>
      new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(t);
          resolve();
        };
        const t = setTimeout(() => {
          ctrl.signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        ctrl.signal.addEventListener('abort', onAbort, { once: true });
      });

    const onFrame = (frame: SseFrame) => {
      if (!isCurrent()) return;
      if (frame.id !== undefined) lastEventId = frame.id || undefined;
      // Any delivered frame means the stream is established and flowing — the
      // handshake ({connected:true}, event defaults to 'message'), periodic
      // stats/health frames on an idle queue, and job:* events all qualify.
      if (frameIndicatesConnected(frame)) {
        // Check again when React evaluates these updaters: an update queued by
        // generation A just before a target switch must not overwrite B's reset.
        setConnected((previous) => (isCurrent() ? true : previous));
        setError((previous) => (isCurrent() ? null : previous));
      }
      if (!frame.event.startsWith('job:')) return;
      const d = activityPayload(frame.data);
      const status = statusFromEvent(frame.event);
      const ev: ActivityEvent = {
        seq: ++seq,
        event: frame.event,
        queue: d.queue,
        jobId: d.jobId,
        name: d.name,
        status,
        timestamp: d.timestamp,
        error: d.error,
        progress: d.progress,
      };
      // Buffer instead of setState-per-frame; the flush timer applies these.
      pendingEvents.push(ev);
      const pc = pendingCounters;
      pc.total += 1;
      if (status === 'completed') pc.completed += 1;
      else if (status === 'failed') pc.failed += 1;
      else if (status === 'waiting') pc.waiting += 1;
      else if (status === 'active') pc.active += 1;
      stamps.current.push(monoNow());
    };

    // Reconnect loop: streamEvents resolves on a clean stream end (server
    // restart / graceful close) and rejects on a network error. In BOTH cases,
    // unless we're tearing down, drop the connected flag and retry after a short
    // backoff so the live view recovers instead of silently going dead.
    const RECONNECT_MS = 2000;
    const MAX_BACKOFF = 8; // × RECONNECT_MS
    const run = async () => {
      let attempts = 0;
      while (!cancelled) {
        let failure: Error | null = null;
        const replayId = lastEventId;
        let deliveredFrame = false;
        try {
          await streamEvents(
            api.eventsUrl(queue),
            (frame) => {
              deliveredFrame = true;
              onFrame(frame);
            },
            ctrl.signal,
            undefined,
            replayId
          );
        } catch (e) {
          // Not necessarily transient: a 401/404 (no /events endpoint, wrong
          // token, proxy rejecting text/event-stream) fails identically every
          // time. Surface it instead of retrying silently forever, and widen
          // the backoff so a permanent failure isn't hammered twice a second.
          failure = e instanceof Error ? e : new Error(String(e));
        }
        // Only explicit response statuses that plausibly reject the replay
        // header may discard it. A network error, auth failure, 5xx, clean EOF,
        // or malformed 2xx response is unrelated to checkpoint validity and
        // must preserve replay. If a newer ID arrived, preserve that too.
        if (
          replayId &&
          !deliveredFrame &&
          lastEventId === replayId &&
          shouldDiscardLastEventId(failure)
        ) {
          lastEventId = undefined;
        }
        if (!isCurrent()) break;
        setConnected((previous) => (isCurrent() ? false : previous));
        setError((previous) => (isCurrent() ? failure : previous));
        attempts = failure ? Math.min(attempts + 1, MAX_BACKOFF) : 0;
        await delay(RECONNECT_MS * Math.max(1, attempts));
      }
    };
    run();

    // Coalesce buffered events/counters into at most ~7 state updates/sec,
    // independent of the stream's frame rate.
    const flushTimer = setInterval(() => {
      if (!isCurrent()) return;
      if (pendingEvents.length) {
        const batch = pendingEvents;
        pendingEvents = [];
        // Reverse OUTSIDE the updater: React can invoke an updater more than
        // once (StrictMode double-invoke), and an in-updater reverse() would
        // mutate `batch` and flip the order back on the second call.
        batch.reverse();
        setEvents((prev) => (isCurrent() ? [...batch, ...prev].slice(0, MAX_EVENTS) : prev));
      }
      const pc = pendingCounters;
      if (pc.total) {
        pendingCounters = { ...EMPTY };
        setCounters((prev) =>
          isCurrent()
            ? {
                total: prev.total + pc.total,
                completed: prev.completed + pc.completed,
                failed: prev.failed + pc.failed,
                waiting: prev.waiting + pc.waiting,
                active: prev.active + pc.active,
              }
            : prev
        );
      }
    }, 150);

    return () => {
      cancelled = true;
      if (streamGeneration.current === generation) streamGeneration.current += 1;
      ctrl.abort();
      clearInterval(flushTimer);
    };
    // Reconnect when the target queue or connection settings change.
  }, [queue, baseUrl, token, targetKey]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = monoNow();
      stamps.current = stamps.current.filter((ts) => ts <= now && now - ts < 5000);
      setThroughput(stamps.current.length / 5);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return {
    events: visibleEvents,
    counters: visibleCounters,
    throughput: visibleThroughput,
    connected: visibleConnected,
    error: visibleError,
  };
}
