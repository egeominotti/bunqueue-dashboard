import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { METRIC_LABELS, useAlertsStore } from '@/components/dashboard/stores/alertsStore';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import {
  alertMetricValue,
  allQueues,
  type Breach,
  compareAlertMetric,
  parseAlertOverview,
  parseAlertQueueSummary,
} from './alertEngineMetrics';
import { notifyAlertBreaches } from './alertEngineNotifications';
import {
  type AlertServerTarget,
  alertConnectionIdentity,
  alertServerTarget,
  createAlertTickClient,
} from './alertEngineTransport';

export type { Breach } from './alertEngineMetrics';
export { allQueues, parseAlertOverview, parseAlertQueueSummary } from './alertEngineMetrics';
export type { AlertQueueClient } from './alertEngineTransport';
export { alertConnectionIdentity } from './alertEngineTransport';

const POLL_MS = 15_000;
const COOLDOWN_MS = 60_000;

interface AlertRuntime {
  breaching: Breach[];
  status: 'idle' | 'checking' | 'live' | 'degraded';
  error: string | null;
  connectionIdentity: string | null;
  setBreaching: (breaches: Breach[]) => void;
}

export const useAlertRuntimeStore = create<AlertRuntime>((set) => ({
  breaching: [],
  status: 'idle',
  error: null,
  connectionIdentity: null,
  setBreaching: (breaching) => set({ breaching }),
}));

/** Request desktop notification permission from a user gesture. */
export async function enableNotifications(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/** Mount once to evaluate enabled browser-local alert rules. */
export function useAlertEngine() {
  const rules = useAlertsStore((state) => state.rules);
  const connectionIdentity = useConnectionStore((state) =>
    alertConnectionIdentity(state.baseUrl, state.token)
  );
  const wasBreaching = useRef<Map<string, boolean>>(new Map());
  const lastNotified = useRef<Map<string, number>>(new Map());
  const breachSince = useRef<Map<string, number>>(new Map());
  const lastBreach = useRef<Map<string, Breach>>(new Map());
  const refsConnection = useRef(connectionIdentity);
  const engineGeneration = useRef(0);
  const signature = JSON.stringify(
    rules
      .filter((rule) => rule.enabled)
      .map((rule) => [rule.id, rule.metric, rule.operator, rule.threshold, rule.queue])
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

    const pruneInactiveRules = (liveIds: Set<string>) => {
      for (const id of [...wasBreaching.current.keys()]) {
        if (liveIds.has(id)) continue;
        wasBreaching.current.delete(id);
        lastNotified.current.delete(id);
        breachSince.current.delete(id);
        lastBreach.current.delete(id);
      }
    };

    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
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
        const active = useAlertsStore.getState().rules.filter((rule) => rule.enabled);
        const liveIds = new Set(active.map((rule) => rule.id));
        pruneInactiveRules(liveIds);
        if (!overview) {
          const breaching = useAlertRuntimeStore
            .getState()
            .breaching.filter((breach) => liveIds.has(breach.ruleId));
          if (!ownsTarget()) return;
          useAlertRuntimeStore.setState({
            breaching,
            status: 'degraded',
            error: 'The bunqueue overview endpoint is unavailable; alert results may be stale.',
            connectionIdentity,
          });
          return;
        }

        const now = Date.now();
        const breaches: Breach[] = [];
        const fresh: Breach[] = [];
        let hasUnknownRule = false;
        for (const rule of active) {
          const value = alertMetricValue(rule, { summary, queues, overview });
          if (value == null) {
            hasUnknownRule = true;
            const previous = wasBreaching.current.get(rule.id)
              ? lastBreach.current.get(rule.id)
              : undefined;
            if (previous) breaches.push(previous);
            continue;
          }
          const isBreach = compareAlertMetric(value, rule.operator, rule.threshold);
          const was = wasBreaching.current.get(rule.id) ?? false;
          if (isBreach) {
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
        notifyAlertBreaches(fresh);
        const partialFailure = !summary || !queues || hasUnknownRule;
        useAlertRuntimeStore.setState({
          breaching: breaches,
          status: partialFailure ? 'degraded' : 'live',
          error: partialFailure
            ? 'Some alert rules could not be evaluated; affected results remain unknown.'
            : null,
          connectionIdentity,
        });
      } catch (error) {
        if (!ownsTarget()) return;
        useAlertRuntimeStore.setState({
          status: 'degraded',
          error: `Alert evaluation failed: ${(error as Error).message}`,
          connectionIdentity,
        });
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      if (engineGeneration.current === generation) engineGeneration.current += 1;
      controller.abort();
      clearInterval(timer);
    };
  }, [signature, connectionIdentity]);
}
