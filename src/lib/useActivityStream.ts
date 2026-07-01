import { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { api } from './api';
import { frameIndicatesConnected, type SseFrame, streamEvents } from './sse';
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

  const stamps = useRef<number[]>([]);

  useEffect(() => {
    const ctrl = new AbortController();
    let seq = 0;
    let cancelled = false;

    setEvents([]);
    setCounters(EMPTY);
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
      // Any delivered frame means the stream is established and flowing — the
      // handshake ({connected:true}, event defaults to 'message'), periodic
      // stats/health frames on an idle queue, and job:* events all qualify.
      if (frameIndicatesConnected(frame)) setConnected(true);
      if (!frame.event.startsWith('job:')) return;
      const d = (frame.data ?? {}) as {
        queue?: string;
        jobId?: string;
        name?: string;
        timestamp?: number;
        error?: string;
        progress?: number;
      };
      const status = statusFromEvent(frame.event);
      const ev: ActivityEvent = {
        seq: ++seq,
        event: frame.event,
        queue: d.queue,
        jobId: d.jobId,
        name: d.name,
        status,
        timestamp: d.timestamp ?? Date.now(),
        error: d.error,
        progress: d.progress,
      };
      setEvents((prev) => [ev, ...prev].slice(0, MAX_EVENTS));
      setCounters((prev) => ({
        total: prev.total + 1,
        completed: prev.completed + (status === 'completed' ? 1 : 0),
        failed: prev.failed + (status === 'failed' ? 1 : 0),
        waiting: prev.waiting + (status === 'waiting' ? 1 : 0),
        active: prev.active + (status === 'active' ? 1 : 0),
      }));
      stamps.current.push(Date.now());
    };

    // Reconnect loop: streamEvents resolves on a clean stream end (server
    // restart / graceful close) and rejects on a network error. In BOTH cases,
    // unless we're tearing down, drop the connected flag and retry after a short
    // backoff so the live view recovers instead of silently going dead.
    const RECONNECT_MS = 2000;
    const run = async () => {
      while (!cancelled) {
        try {
          await streamEvents(api.eventsUrl(queue), onFrame, ctrl.signal);
        } catch {
          /* network error — fall through to reconnect */
        }
        if (cancelled) break;
        setConnected(false);
        await delay(RECONNECT_MS);
      }
    };
    run();

    return () => {
      cancelled = true;
      ctrl.abort();
      setConnected(false);
    };
    // Reconnect when the target queue or connection settings change.
  }, [queue, baseUrl, token]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      stamps.current = stamps.current.filter((ts) => now - ts < 5000);
      setThroughput(stamps.current.length / 5);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return { events, counters, throughput, connected };
}
