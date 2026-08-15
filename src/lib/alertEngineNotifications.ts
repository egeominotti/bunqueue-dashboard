import { toast } from '@/components/dashboard/stores/toastStore';
import type { Breach } from './alertEngineMetrics';

const MAX_INLINE_TOASTS = 3;
const breachBody = (breach: Breach): string =>
  `${breach.queue || 'All queues'}: ${breach.metricLabel} ${breach.operator} ${breach.threshold} (now ${Math.round(breach.value)})`;

function desktopNotify(breach: Breach) {
  if (globalThis.Notification?.permission === 'granted') {
    try {
      new Notification(`bunqueue alert: ${breach.ruleName}`, {
        body: breachBody(breach),
        tag: breach.ruleId,
      });
    } catch {
      // Notifications can be unsupported or blocked independently of permission.
    }
  }
}

export function notifyAlertBreaches(breaches: Breach[]) {
  if (breaches.length <= MAX_INLINE_TOASTS) {
    for (const breach of breaches) {
      toast.error(`Alert: ${breach.ruleName}`, breachBody(breach));
      desktopNotify(breach);
    }
    return;
  }
  toast.error(
    `${breaches.length} alert rules breaching`,
    breaches.map((item) => item.ruleName).join(', ')
  );
  for (const breach of breaches) desktopNotify(breach);
}
