import { useEffect, useRef } from 'react';
import { getBaseUrl, useConnectionStore } from '@/components/dashboard/stores/connectionStore';

const activeLocks = new Map<string, symbol>();

/** Exact server+credential identity used by the non-reactive bq transport. */
export function currentServerActionIdentity(): string {
  const token = useConnectionStore.getState().token.trim();
  return JSON.stringify([getBaseUrl(), token]);
}

let serverActionEpoch = 0;
let observedServerActionIdentity = currentServerActionIdentity();
useConnectionStore.subscribe(() => {
  const next = currentServerActionIdentity();
  if (next === observedServerActionIdentity) return;
  observedServerActionIdentity = next;
  serverActionEpoch += 1;
});

export interface ServerActionLease {
  /** False after unmount, owner/route change, or any connection generation change. */
  isCurrent: () => boolean;
  /** Release the synchronous mutex. Returns whether this lease still owns the UI scope. */
  finish: () => boolean;
}

/** Mutations in v2.9.0 acknowledge success with a JSON `{ ok: true, ... }` envelope. */
export function assertSuccessfulMutationResponse(
  response: unknown,
  action = 'Operation'
): asserts response is { ok: true } & Record<string, unknown> {
  if (
    response == null ||
    typeof response !== 'object' ||
    (response as { ok?: unknown }).ok !== true
  ) {
    throw new Error(`${action} returned a malformed success response`);
  }
}

/**
 * Lifecycle + same-tick guard for non-idempotent control actions.
 *
 * React state disables the button only after the next render, so it is not a
 * mutex. This hook acquires module-global keys synchronously and invalidates a
 * lease's UI ownership when the server credential, route/queue owner, or mount changes. The
 * Zustand subscription is synchronous: even A→B→A between React commits cannot
 * make an old A request current again.
 */
export function useServerActionGuard(ownerKey: string): {
  scopeKey: string;
  begin: (keys?: string | readonly string[]) => ServerActionLease | null;
} {
  // Subscribe for rendering/UI resets; correctness also has the synchronous
  // store subscription below and never relies on React committing in time.
  useConnectionStore((state) => `${state.baseUrl}\u0000${state.token}`);
  const connectionIdentity = currentServerActionIdentity();
  const connectionEpoch = serverActionEpoch;
  const scopeKey = JSON.stringify([connectionEpoch, ownerKey]);
  const mounted = useRef(false);
  const generation = useRef(0);
  const scope = useRef(scopeKey);

  if (scope.current !== scopeKey) {
    scope.current = scopeKey;
    generation.current += 1;
  }

  useEffect(() => {
    mounted.current = true;
    let lastConnection = currentServerActionIdentity();
    const unsubscribe = useConnectionStore.subscribe(() => {
      const next = currentServerActionIdentity();
      if (next === lastConnection) return;
      lastConnection = next;
      generation.current += 1;
    });
    return () => {
      mounted.current = false;
      generation.current += 1;
      unsubscribe();
    };
  }, []);

  const begin = (requested: string | readonly string[] = 'action'): ServerActionLease | null => {
    const keys = [...new Set(typeof requested === 'string' ? [requested] : requested)];
    const lockKeys = keys.map((key) => JSON.stringify([connectionEpoch, ownerKey, key]));
    if (
      !mounted.current ||
      keys.length === 0 ||
      scope.current !== scopeKey ||
      serverActionEpoch !== connectionEpoch ||
      currentServerActionIdentity() !== connectionIdentity ||
      lockKeys.some((key) => activeLocks.has(key))
    ) {
      return null;
    }
    const token = Symbol('server-action');
    for (const key of lockKeys) activeLocks.set(key, token);
    const myGeneration = generation.current;
    const isCurrent = () =>
      mounted.current &&
      generation.current === myGeneration &&
      scope.current === scopeKey &&
      serverActionEpoch === connectionEpoch &&
      currentServerActionIdentity() === connectionIdentity;
    return {
      isCurrent,
      finish: () => {
        const current = isCurrent();
        for (const key of lockKeys) {
          if (activeLocks.get(key) === token) activeLocks.delete(key);
        }
        return current;
      },
    };
  };

  return { scopeKey, begin };
}
