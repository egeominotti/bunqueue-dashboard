import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import {
  type AlertRule,
  METRIC_LABELS,
  type Operator,
  useAlertsStore,
} from '@/components/dashboard/stores/alertsStore';
import {
  normalizeBaseUrl,
  useConnectionStore,
} from '@/components/dashboard/stores/connectionStore';
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
  status: 'idle' | 'checking' | 'live' | 'degraded';
  error: string | null;
  /** Connection generation that owns every value above. */
  connectionIdentity: string | null;
  setBreaching: (b: Breach[]) => void;
}

/** Live "currently breaching" set, written by the engine, read by the Alerts page. */
export const useAlertRuntimeStore = create<AlertRuntime>((set) => ({
  breaching: [],
  status: 'idle',
  error: null,
  connectionIdentity: null,
  setBreaching: (breaching) => set({ breaching }),
}));

/** Stable identity for alert metrics (the control-agent token is not used here). */
export const alertConnectionIdentity = (baseUrl: string, token: string): string =>
  JSON.stringify([baseUrl, token]);

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
type QueuePage = Awaited<ReturnType<typeof bq.queues>>;

/** Smallest client surface needed to walk the paginated queue snapshot. */
export interface AlertQueueClient {
  queues: (limit?: number, offset?: number) => Promise<QueuePage>;
}

interface AlertTickClient extends AlertQueueClient {
  queuesSummary: () => Promise<unknown>;
  overview: () => Promise<unknown>;
}

interface AlertServerTarget {
  readonly baseUrl: string;
  readonly authorization?: string;
}

const ALERT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Turn the render's identity into one immutable transport target. The token is
 * kept as its final Authorization value so no request in this effect can read a
 * later connection-store value. Invalid injected URLs fail closed rather than
 * receiving a bearer credential (normal Settings writes are already sanitized).
 */
function alertServerTarget(connectionIdentity: string): AlertServerTarget {
  const value = JSON.parse(connectionIdentity) as unknown;
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError('Invalid alert connection identity.');
  }
  const [rawBaseUrl, rawToken] = value;
  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  if (!baseUrl || typeof rawToken !== 'string') {
    throw new TypeError('Invalid alert server target.');
  }
  const token = rawToken.trim();
  return Object.freeze({
    baseUrl,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
}

/**
 * Per-tick metrics client pinned to one URL+bearer pair and the owning effect's
 * lifecycle. This deliberately does not call the global `bq` client: its read
 * methods resolve Settings afresh per request, which can split queue pages
 * across servers during a retarget.
 */
function createAlertTickClient(
  target: AlertServerTarget,
  lifecycleSignal: AbortSignal
): AlertTickClient {
  const headers = new Headers({ Accept: 'application/json' });
  if (target.authorization) headers.set('Authorization', target.authorization);

  const request = async (path: string): Promise<unknown> => {
    lifecycleSignal.throwIfAborted();
    const signal = AbortSignal.any([
      lifecycleSignal,
      AbortSignal.timeout(ALERT_REQUEST_TIMEOUT_MS),
    ]);
    const response = await fetch(target.baseUrl + path, {
      headers,
      signal,
    });
    // Test doubles and non-standard streams can ignore AbortSignal. Check the
    // lifecycle again before consuming or returning their late response.
    lifecycleSignal.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 && typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('auth:required', {
            detail: {
              scope: 'server',
              auth: target.authorization,
              target: target.baseUrl,
            },
          })
        );
      }
      throw new Error(`Alert metrics request failed: HTTP ${response.status}`);
    }
    const text = await response.text();
    lifecycleSignal.throwIfAborted();
    if (!text) throw new Error('Alert metrics request returned an empty response.');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Alert metrics request returned invalid JSON (HTTP ${response.status}).`);
    }
  };

  return Object.freeze({
    queuesSummary: () => request('/queues/summary'),
    queues: (limit = 500, offset = 0) =>
      request(`/dashboard/queues?limit=${limit}&offset=${offset}`) as Promise<QueuePage>,
    overview: () => request('/dashboard'),
  });
}

interface MetricCtx {
  // null ⇒ that source's fetch FAILED this tick (distinct from an empty deployment)
  // so its metrics are treated as "unknown" rather than 0 — avoids false `<`-rule
  // trips while a call is transiently failing but the server is otherwise up.
  summary: SummaryRow[] | null;
  queues: QueueRow[] | null;
  overview: Overview | null;
}

const MAX_ALERT_QUEUES = 10_500;

function alertCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseAlertQueueSummary(value: unknown): SummaryRow[] | null {
  if (!Array.isArray(value) || value.length > MAX_ALERT_QUEUES) return null;
  const names = new Set<string>();
  const rows: SummaryRow[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const row = candidate as Record<string, unknown>;
    const counts = row.counts;
    if (
      typeof row.name !== 'string' ||
      !row.name ||
      row.name.length > 256 ||
      !/^[a-zA-Z0-9_\-.:]+$/.test(row.name) ||
      names.has(row.name) ||
      typeof row.paused !== 'boolean' ||
      !counts ||
      typeof counts !== 'object' ||
      Array.isArray(counts)
    ) {
      return null;
    }
    const values = counts as Record<string, unknown>;
    if (
      !['waiting', 'active', 'completed', 'failed', 'delayed'].every((key) =>
        alertCount(values[key])
      )
    ) {
      return null;
    }
    names.add(row.name);
    rows.push(candidate as SummaryRow);
  }
  return rows;
}

export function parseAlertOverview(value: unknown): Overview | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (
    root.ok !== true ||
    !root.latency ||
    typeof root.latency !== 'object' ||
    Array.isArray(root.latency)
  ) {
    return null;
  }
  const percentiles = (root.latency as Record<string, unknown>).percentiles;
  if (!percentiles || typeof percentiles !== 'object' || Array.isArray(percentiles)) return null;
  for (const operation of Object.values(percentiles)) {
    if (
      !operation ||
      typeof operation !== 'object' ||
      Array.isArray(operation) ||
      typeof (operation as { p99?: unknown }).p99 !== 'number' ||
      !Number.isFinite((operation as { p99: number }).p99) ||
      (operation as { p99: number }).p99 < 0
    ) {
      return null;
    }
  }
  return value as Overview;
}

const pct = (completed: number, failed: number): number | null => {
  const total = completed + failed;
  // No observations means the error rate is unknown, not 0%. Publishing zero
  // would falsely breach a `<` rule and falsely clear a `>` rule.
  return total > 0 ? (failed / total) * 100 : null;
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
const QUEUE_PAGE_SIZE = 500;
const MAX_QUEUE_PAGES = 21; // first page + 20 continuations = at most 10,500 rows

function queuePage(
  value: unknown,
  expectedOffset: number,
  expectedTotal: number | null
): { queues: QueueRow[]; total: number } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const page = value as Record<string, unknown>;
  if (page.ok !== true || !Array.isArray(page.queues)) return null;
  if (
    typeof page.total !== 'number' ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    page.total > MAX_ALERT_QUEUES ||
    (expectedTotal !== null && page.total !== expectedTotal)
  ) {
    return null;
  }
  // The endpoint contract echoes the requested window. Rejecting a mismatched
  // offset/limit prevents a unique-but-overlapping or skipped page from looking
  // complete merely because its row count reaches `total`.
  if (page.offset !== expectedOffset || page.limit !== QUEUE_PAGE_SIZE) return null;

  const expectedRows = Math.min(QUEUE_PAGE_SIZE, page.total - expectedOffset);
  if (expectedRows < 0 || page.queues.length !== expectedRows) return null;

  const queues: QueueRow[] = [];
  for (const candidate of page.queues) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return null;
    }
    const row = candidate as Record<string, unknown>;
    // allQueues exists solely to evaluate the DLQ metric, so accepting a bad
    // name/count would turn malformed data into a false queue match or NaN sum.
    if (
      typeof row.name !== 'string' ||
      row.name.length === 0 ||
      row.name.length > 256 ||
      !/^[a-zA-Z0-9_\-.:]+$/.test(row.name) ||
      typeof row.dlq !== 'number' ||
      !Number.isSafeInteger(row.dlq) ||
      row.dlq < 0
    ) {
      return null;
    }
    queues.push(candidate as QueueRow);
  }
  return { queues, total: page.total };
}

export async function allQueues(client: AlertQueueClient = bq): Promise<QueueRow[] | null> {
  try {
    const rows: QueueRow[] = [];
    const names = new Set<string>();
    let total: number | null = null;

    for (let pageNumber = 0; pageNumber < MAX_QUEUE_PAGES; pageNumber++) {
      const parsed = queuePage(
        await client.queues(QUEUE_PAGE_SIZE, rows.length),
        rows.length,
        total
      );
      if (!parsed) return null;
      total ??= parsed.total;
      for (const row of parsed.queues) {
        // Queue names are unique. Seeing one twice means page overlap or a
        // deployment mutating under offset pagination; either way the snapshot
        // is incomplete and must not be published as a trustworthy total.
        if (names.has(row.name)) return null;
        names.add(row.name);
        rows.push(row);
      }
      if (rows.length === total) return rows;
    }
    // The page cap was reached before the advertised total: incomplete.
    return null;
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
  const connectionIdentity = useConnectionStore((s) => alertConnectionIdentity(s.baseUrl, s.token));
  const wasBreaching = useRef<Map<string, boolean>>(new Map());
  const lastNotified = useRef<Map<string, number>>(new Map());
  // When each currently-breaching rule STARTED breaching, so the Alerts page can
  // show a real "since" instead of resetting to now on every poll.
  const breachSince = useRef<Map<string, number>>(new Map());
  // Last published breach per rule, so a tick that can't evaluate a rule (its
  // metric source failed) carries the known breach forward instead of dropping
  // it — an unevaluated rule must never be published as "within threshold".
  const lastBreach = useRef<Map<string, Breach>>(new Map());
  const refsConnection = useRef(connectionIdentity);
  const engineGeneration = useRef(0);

  // Re-arm the poller only when the enabled-rule set actually changes (not on
  // every unrelated store update), keyed by a stable signature. Empty ⇒ no
  // enabled rules, so the loop stays idle.
  const signature = JSON.stringify(
    rules.filter((r) => r.enabled).map((r) => [r.id, r.metric, r.operator, r.threshold, r.queue])
  );

  useEffect(() => {
    const clearEvaluationState = () => {
      wasBreaching.current.clear();
      lastNotified.current.clear();
      breachSince.current.clear();
      lastBreach.current.clear();
    };
    const identityChanged = refsConnection.current !== connectionIdentity;
    if (identityChanged) {
      refsConnection.current = connectionIdentity;
      clearEvaluationState();
    }

    if (signature === '[]') {
      clearEvaluationState();
      useAlertRuntimeStore.setState({
        breaching: [],
        status: 'idle',
        error: null,
        connectionIdentity,
      });
      return;
    }

    const enabledIds = new Set(
      useAlertsStore
        .getState()
        .rules.filter((rule) => rule.enabled)
        .map((rule) => rule.id)
    );
    const previousBreaches = identityChanged
      ? []
      : useAlertRuntimeStore.getState().breaching.filter((breach) => enabledIds.has(breach.ruleId));
    useAlertRuntimeStore.setState({
      breaching: previousBreaches,
      status: 'checking',
      error: null,
      connectionIdentity,
    });

    let target: AlertServerTarget;
    try {
      target = alertServerTarget(connectionIdentity);
    } catch (error) {
      useAlertRuntimeStore.setState({
        breaching: [],
        status: 'degraded',
        error: `Alert evaluation failed: ${(error as Error).message}`,
        connectionIdentity,
      });
      return;
    }

    const controller = new AbortController();
    const generation = ++engineGeneration.current;
    let cancelled = false;
    let inFlight = false;
    const ownsTarget = () => {
      if (cancelled || engineGeneration.current !== generation) return false;
      const current = useConnectionStore.getState();
      return alertConnectionIdentity(current.baseUrl, current.token) === connectionIdentity;
    };

    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        // One client/target for summary, overview, and every queue page in this
        // tick. No call below is allowed to consult the live connection store.
        const client = createAlertTickClient(target, controller.signal);
        const [summary, queues, overview] = await Promise.all([
          client
            .queuesSummary()
            .then(parseAlertQueueSummary)
            .catch(() => null),
          allQueues(client),
          client
            .overview()
            .then(parseAlertOverview)
            .catch(() => null),
        ]);
        if (!ownsTarget()) return;
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
          if (!ownsTarget()) return;
          useAlertRuntimeStore.setState({
            breaching: kept,
            status: 'degraded',
            error: 'The bunqueue overview endpoint is unavailable; alert results may be stale.',
            connectionIdentity,
          });
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
        let hasUnknownRule = false;
        for (const rule of active) {
          const value = metricValue(rule, ctx);
          if (value == null) {
            hasUnknownRule = true;
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
        if (!ownsTarget()) return;
        notifyAll(fresh);
        const partialFailure = !summary || !queues || hasUnknownRule;
        useAlertRuntimeStore.setState({
          breaching: breaches,
          status: partialFailure ? 'degraded' : 'live',
          error: partialFailure
            ? 'Some alert rules could not be evaluated; affected results remain unknown.'
            : null,
          connectionIdentity,
        });
      } catch (tickError) {
        if (!ownsTarget()) return;
        useAlertRuntimeStore.setState({
          status: 'degraded',
          error: `Alert evaluation failed: ${(tickError as Error).message}`,
          connectionIdentity,
        });
      } finally {
        inFlight = false;
      }
    };

    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      if (engineGeneration.current === generation) engineGeneration.current += 1;
      controller.abort();
      clearInterval(timer);
    };
  }, [signature, connectionIdentity]);
}
