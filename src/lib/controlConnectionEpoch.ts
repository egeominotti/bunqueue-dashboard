import { useSyncExternalStore } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';

let epoch = 0;
const listeners = new Set<() => void>();

useConnectionStore.subscribe((next, previous) => {
  if (
    next.baseUrl === previous.baseUrl &&
    next.agentBaseUrl === previous.agentBaseUrl &&
    next.activeProfileId === previous.activeProfileId &&
    next.token === previous.token &&
    next.agentToken === previous.agentToken
  ) {
    return;
  }
  epoch += 1;
  for (const listener of listeners) listener();
});

/**
 * Opaque synchronous identity for the managed server and both credential scopes.
 * The monotonic value detects A -> B -> A retargets without serializing a secret.
 */
export function currentControlConnectionEpoch(): number {
  return epoch;
}

export function useControlConnectionEpoch(): number {
  return useSyncExternalStore(
    subscribe,
    currentControlConnectionEpoch,
    currentControlConnectionEpoch
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
