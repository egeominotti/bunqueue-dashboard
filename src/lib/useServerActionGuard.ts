import { useEffect, useRef } from 'react';
import { getBaseUrl, useConnectionStore } from '@/components/dashboard/stores/connectionStore';

/** Exact server+credential identity used by the non-reactive bq transport. */
export function currentServerActionIdentity(): string {
  const token = useConnectionStore.getState().token.trim();
  return JSON.stringify([getBaseUrl(), token]);
}

export interface ServerActionLease {
  /** False after unmount, owner/route change, or any connection generation change. */
  isCurrent: () => boolean;
  /** Release the synchronous mutex. Returns whether this lease still owns the UI scope. */
  finish: () => boolean;
}

/** Mutations in v2.8.55 acknowledge success with a JSON `{ ok: true, ... }` envelope. */
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
 * mutex. This hook acquires ref-backed keys synchronously and invalidates every
 * lease when the server credential, route/queue owner, or mount changes. The
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
  const scopeKey = `${connectionIdentity}\u0000${ownerKey}`;
  const mounted = useRef(false);
  const generation = useRef(0);
  const scope = useRef(scopeKey);
  const locks = useRef(new Map<string, symbol>());

  if (scope.current !== scopeKey) {
    scope.current = scopeKey;
    generation.current += 1;
    locks.current.clear();
  }

  useEffect(() => {
    mounted.current = true;
    let lastConnection = currentServerActionIdentity();
    const unsubscribe = useConnectionStore.subscribe(() => {
      const next = currentServerActionIdentity();
      if (next === lastConnection) return;
      lastConnection = next;
      generation.current += 1;
      locks.current.clear();
    });
    return () => {
      mounted.current = false;
      generation.current += 1;
      locks.current.clear();
      unsubscribe();
    };
  }, []);

  const begin = (requested: string | readonly string[] = 'action'): ServerActionLease | null => {
    const keys = [...new Set(typeof requested === 'string' ? [requested] : requested)];
    if (
      !mounted.current ||
      keys.length === 0 ||
      scope.current !== scopeKey ||
      currentServerActionIdentity() !== connectionIdentity ||
      keys.some((key) => locks.current.has(key))
    ) {
      return null;
    }
    const token = Symbol('server-action');
    for (const key of keys) locks.current.set(key, token);
    const myGeneration = generation.current;
    const isCurrent = () =>
      mounted.current &&
      generation.current === myGeneration &&
      scope.current === scopeKey &&
      currentServerActionIdentity() === connectionIdentity;
    return {
      isCurrent,
      finish: () => {
        const current = isCurrent();
        for (const key of keys) {
          if (locks.current.get(key) === token) locks.current.delete(key);
        }
        return current;
      },
    };
  };

  return { scopeKey, begin };
}
