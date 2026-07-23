import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import {
  type AlertRule,
  METRIC_LABELS,
  type Operator,
  useAlertsStore,
} from '@/components/dashboard/stores/alertsStore';
import { toast } from '@/components/dashboard/stores/toastStore';
import { bq } from '@/lib/bq';

/**
 * Client-side alert evaluation. bunqueue OSS has no server alerting backend, but
 * the dashboard already polls every metric — so we can evaluate the rules in the
 * browser and fire a desktop Notification + in-app toast when a threshold is
 * crossed. Runs while any tab is open (even backgrounded); it is NOT away-from-desk
 * paging, which needs the email/webhook/slack delivery the store models.
 */

const POLL_MS = 15000;
const COOLDOWN_MS = 60000;
// A same-tick fan-out larger than this would evict its own earliest toasts
// before <Toaster/> ever paints them (toastStore caps the stack at 5), so a
// burst is collapsed into a single summary toast instead of being swallowed.
const MAX_INLINE_TOASTS = 3;

export interface Breach {
  ruleId: string;
  ruleName: string;
  metricLabel: string;
  operator: Operator;
  threshold: number;
  value: number;
  queue: string;
  at: number;
}

interface AlertRuntime {
  breaching: Breach[];
  setBreaching: (b: Breach[]) => void;
}

/** Live "currently breaching" set, written by the engine, read by the Alerts page. */
export const useAlertRuntimeStore = create<AlertRuntime>((set) => ({
  breaching: [],
  setBreaching: (breaching) => set({ breaching }),
}));

/** Ask the browser for notification permission (must be called from a user gesture). */
export async function enableNotifications(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

function compare(value: number, op: Operator, threshold: number): boolean {
  switch (op) {
    case '>=':
      return value >= threshold;
    case '>':
      return value > threshold;
    case '<=':
      return value <= threshold;
    case '<':
      return value < threshold;
    default:
      return false;
  }
}

type SummaryRow = Awaited<ReturnType<typeof bq.queuesSummary>>[number];
type QueueRow = Awaited<ReturnType<typeof bq.queues>>['queues'][number];
type Overview = Awaited<ReturnType<typeof bq.overview>>;

interface MetricCtx {
  // null ⇒ that source's fetch FAILED this tick (distinct from an empty deployment)
  // so its metrics are treated as "unknown" rather than 0 — avoids false `<`-rule
  // trips while a call is transiently failing but the server is otherwise up.
  summary: SummaryRow[] | null;
  queues: QueueRow[] | null;
  overview: Overview | null;
}

const pct = (completed: number, failed: number): number => {
  const total = completed + failed;
  return total > 0 ? (failed / total) * 100 : 0;
};

/** Resolve a rule's current metric value, or null when the data isn't available. */
function metricValue(rule: AlertRule, ctx: MetricCtx): number | null {
  const q = rule.queue.trim();
  switch (rule.metric) {
    case 'waiting': {
      if (!ctx.summary) return null;
      if (q) return ctx.summary.find((s) => s.name === q)?.counts.waiting ?? null;
      return ctx.summary.reduce((a, s) => a + s.counts.waiting, 0);
    }
    case 'failed': {
      if (!ctx.summary) return null;
      if (q) return ctx.summary.find((s) => s.name === q)?.counts.failed ?? null;
      return ctx.summary.reduce((a, s) => a + s.counts.failed, 0);
    }
    case 'dlq': {
      if (!ctx.queues) return null;
      if (q) return ctx.queues.find((s) => s.name === q)?.dlq ?? null;
      return ctx.queues.reduce((a, s) => a + (s.dlq ?? 0), 0);
    }
    case 'error_rate': {
      if (!ctx.summary) return null;
      if (q) {
        const row = ctx.summary.find((s) => s.name === q);
        return row ? pct(row.counts.completed, row.counts.failed) : null;
      }
      return pct(
        ctx.summary.reduce((a, s) => a + s.counts.completed, 0),
        ctx.summary.reduce((a, s) => a + s.counts.failed, 0)
      );
    }
    case 'p99_latency': {
      // Global only — bunqueue exposes latency percentiles keyed by TCP operation
      // (push/pull/ack), not per queue, so a queue-scoped p99 rule can't be honored
      // and evaluates the global max operation p99.
      const perc = ctx.overview?.latency?.percentiles;
      if (!perc) return null;
      const vals = Object.values(perc)
        .map((o) => o.p99)
        .filter((v) => Number.isFinite(v));
      return vals.length ? Math.max(...vals) : null;
    }
    default:
      return null;
  }
}

const breachBody = (breach: Breach): string =>
  `${breach.queue || 'All queues'}: ${breach.metricLabel} ${breach.operator} ${breach.threshold} (now ${Math.round(breach.value)})`;

function desktopNotify(breach: Breach) {
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      // tag = ruleId collapses repeats for the same rule into one desktop toast.
      new Notification(`bunqueue alert: ${breach.ruleName}`, {
        body: breachBody(breach),
        tag: breach.ruleId,
      });
    } catch {
      /* notifications unsupported / blocked */
    }
  }
}

function notify(breach: Breach) {
  toast.error(`Alert: ${breach.ruleName}`, breachBody(breach));
  desktopNotify(breach);
}

/**
 * Deliver a tick's fresh breaches. Beyond MAX_INLINE_TOASTS the in-app toasts
 * would evict each other before rendering, so they collapse into one summary
 * toast; the desktop notifications stay per-rule (the browser dedupes by tag).
 */
function notifyAll(breaches: Breach[]) {
  if (breaches.length <= MAX_INLINE_TOASTS) {
    for (const b of breaches) notify(b);
    return;
  }
  toast.error(
    `${breaches.length} alert rules breaching`,
    breaches.map((b) => b.ruleName).join(', ')
  );
  for (const b of breaches) desktopNotify(b);
}

/**
 * Every queue, not just the first page: `bq.queues()` is paginated (default
 * limit 500) and the dlq metric must see the whole deployment — a truncated
 * page makes a rule scoped to queue #501 look permanently "unknown" and a
 * global dlq sum silently under-count. null ⇒ the fetch failed.
 */
async function allQueues(): Promise<QueueRow[] | null> {
  try {
    const first = await bq.queues();
    const rows = [...first.queues];
    const total = first.total ?? rows.length;
    // Bounded: 20 extra pages of 500 = 10k queues, plenty, and can't spin.
    for (let page = 0; rows.length < total && page < 20; page++) {
      const next = await bq.queues(500, rows.length);
      if (!next.queues.length) break;
      rows.push(...next.queues);
    }
    return rows;
  } catch {
    return null;
  }
}

/**
 * Headless hook (mount once, e.g. in AppLayout). Polls the metrics behind the
 * enabled alert rules and raises a notification on each fresh threshold crossing
 * (edge-triggered, with a per-rule cooldown so a flapping metric can't spam).
 */
export function useAlertEngine() {
  const rules = useAlertsStore((s) => s.rules);
  const setBreaching = useAlertRuntimeStore((s) => s.setBreaching);
  const wasBreaching = useRef<Map<string, boolean>>(new Map());
  const lastNotified = useRef<Map<string, number>>(new Map());
  // When each currently-breaching rule STARTED breaching, so the Alerts page can
  // show a real "since" instead of resetting to now on every poll.
  const breachSince = useRef<Map<string, number>>(new Map());
  // Last published breach per rule, so a tick that can't evaluate a rule (its
  // metric source failed) carries the known breach forward instead of dropping
  // it — an unevaluated rule must never be published as "within threshold".
  const lastBreach = useRef<Map<string, Breach>>(new Map());

  // Re-arm the poller only when the enabled-rule set actually changes (not on
  // every unrelated store update), keyed by a stable signature. Empty ⇒ no
  // enabled rules, so the loop stays idle.
  const signature = rules
    .filter((r) => r.enabled)
    .map((r) => `${r.id}:${r.metric}:${r.operator}:${r.threshold}:${r.queue}`)
    .join('|');

  useEffect(() => {
    if (!signature) {
      setBreaching([]);
      wasBreaching.current.clear();
      lastNotified.current.clear();
      breachSince.current.clear();
      lastBreach.current.clear();
      return;
    }
    let cancelled = false;
    let inFlight = false;

    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const [summary, queues, overview] = await Promise.all([
          bq.queuesSummary().catch(() => null),
          allQueues(),
          bq.overview().catch(() => null),
        ]);
        if (cancelled) return;
        const active = useAlertsStore.getState().rules.filter((r) => r.enabled);
        const liveIds = new Set(active.map((r) => r.id));
        // Forget state for rules that were deleted/disabled. Runs BEFORE the
        // metric gate below: pruning a rule the operator just removed must not
        // depend on the server being reachable.
        for (const id of [...wasBreaching.current.keys()]) {
          if (!liveIds.has(id)) {
            wasBreaching.current.delete(id);
            lastNotified.current.delete(id);
            breachSince.current.delete(id);
            lastBreach.current.delete(id);
          }
        }
        // If the core overview call failed the server is (likely) unreachable —
        // skip this tick rather than treating absent data as zeros, which would
        // falsely trip a `<`-threshold rule while the server is simply down. A
        // partial failure (summary/queues) is handled per-metric (returns null).
        // Rows for rules that no longer exist are still dropped.
        if (!overview) {
          const current = useAlertRuntimeStore.getState().breaching;
          const kept = current.filter((b) => liveIds.has(b.ruleId));
          if (kept.length !== current.length) setBreaching(kept);
          return;
        }
        const ctx: MetricCtx = {
          summary,
          queues,
          overview,
        };
        const now = Date.now();
        const breaches: Breach[] = [];
        const fresh: Breach[] = [];
        for (const rule of active) {
          const value = metricValue(rule, ctx);
          if (value == null) {
            // Unknown ≠ resolved: keep publishing the last known breach so the
            // Alerts page can't claim "all clear" on the strength of a fetch
            // that failed. State refs are left untouched (still breaching).
            const prev = wasBreaching.current.get(rule.id)
              ? lastBreach.current.get(rule.id)
              : undefined;
            if (prev) breaches.push(prev);
            continue;
          }
          const isBreach = compare(value, rule.operator, rule.threshold);
          const was = wasBreaching.current.get(rule.id) ?? false;
          if (isBreach) {
            // Onset time: keep the first tick this breach was seen, not `now`.
            const since = was ? (breachSince.current.get(rule.id) ?? now) : now;
            breachSince.current.set(rule.id, since);
            const breach: Breach = {
              ruleId: rule.id,
              ruleName: rule.name,
              metricLabel: METRIC_LABELS[rule.metric],
              operator: rule.operator,
              threshold: rule.threshold,
              value,
              queue: rule.queue,
              at: since,
            };
            breaches.push(breach);
            lastBreach.current.set(rule.id, breach);
            // The cooldown must DEFER, not drop: comparing the last
            // notification against this episode's onset keeps it one
            // notification per breach episode (`notifiedAt < since`) while
            // still throttling a flapping metric — an edge suppressed by the
            // cooldown fires as soon as the cooldown expires instead of being
            // swallowed forever by the `wasBreaching` latch.
            const notifiedAt = lastNotified.current.get(rule.id) ?? 0;
            if (now - notifiedAt > COOLDOWN_MS && notifiedAt < since) {
              fresh.push(breach);
              lastNotified.current.set(rule.id, now);
            }
          } else {
            breachSince.current.delete(rule.id);
            lastBreach.current.delete(rule.id);
          }
          wasBreaching.current.set(rule.id, isBreach);
        }
        notifyAll(fresh);
        setBreaching(breaches);
      } finally {
        inFlight = false;
      }
    };

    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [signature, setBreaching]);
}
