import { useEffect, useRef } from 'react';
import { currentControlConnectionEpoch, useControlConnectionEpoch } from './controlConnectionEpoch';

const activeLocks = new Map<string, symbol>();

export interface ControlActionLease {
  /** False after unmount, owner change, or any control-connection retarget. */
  isCurrent: () => boolean;
  /** Release the synchronous mutex and report whether this UI still owns it. */
  finish: () => boolean;
}

/** Ref-backed mutex and ownership guard for control-agent operations. */
export function useControlActionGuard(ownerKey: string): {
  scopeKey: string;
  begin: (keys?: string | readonly string[]) => ControlActionLease | null;
} {
  const connectionEpoch = useControlConnectionEpoch();
  const scopeKey = `${connectionEpoch}\u0000${ownerKey}`;
  const mounted = useRef(false);
  const generation = useRef(0);
  const scope = useRef(scopeKey);

  if (scope.current !== scopeKey) {
    scope.current = scopeKey;
    generation.current += 1;
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  const begin = (requested: string | readonly string[] = 'action'): ControlActionLease | null => {
    const keys = [...new Set(typeof requested === 'string' ? [requested] : requested)];
    const lockKeys = keys.map((key) => `${connectionEpoch}\u0000${key}`);
    if (
      !mounted.current ||
      keys.length === 0 ||
      scope.current !== scopeKey ||
      currentControlConnectionEpoch() !== connectionEpoch ||
      lockKeys.some((key) => activeLocks.has(key))
    ) {
      return null;
    }
    const token = Symbol('control-action');
    for (const key of lockKeys) {
      activeLocks.set(key, token);
    }
    const myGeneration = generation.current;
    const isCurrent = () =>
      mounted.current &&
      generation.current === myGeneration &&
      scope.current === scopeKey &&
      currentControlConnectionEpoch() === connectionEpoch;
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
