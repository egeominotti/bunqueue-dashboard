import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  currentControlConnectionEpoch,
  useControlConnectionEpoch,
} from '@/lib/controlConnectionEpoch';

interface RequestIdentity {
  key: string;
  connectionEpoch: number;
}

interface ActiveRequest {
  id: number;
  identity: RequestIdentity;
}

interface PendingRequest extends ActiveRequest {
  label: string;
}

interface RequestValue<T> {
  identity: RequestIdentity;
  value: T;
}

interface RequestFailure {
  identity: RequestIdentity;
  message: string;
}

export function flowRequestKey(...parts: readonly string[]): string {
  return JSON.stringify(parts);
}

export function useLatestFlowRequest<T>(contextKey: string) {
  const connectionEpoch = useControlConnectionEpoch();
  const identity = useMemo<RequestIdentity>(
    () => ({ key: contextKey, connectionEpoch }),
    [connectionEpoch, contextKey]
  );
  const identityRef = useRef(identity);
  const lockedRef = useRef<ActiveRequest | undefined>(undefined);
  const latestRef = useRef<ActiveRequest | undefined>(undefined);
  const sequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const [pending, setPending] = useState<PendingRequest>();
  const [resultState, setResultState] = useState<RequestValue<T>>();
  const [failure, setFailure] = useState<RequestFailure>();

  useLayoutEffect(() => {
    identityRef.current = identity;
    lockedRef.current = undefined;
    latestRef.current = undefined;
  }, [identity]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lockedRef.current = undefined;
      latestRef.current = undefined;
    };
  }, []);

  const run = async (label: string, task: () => Promise<T>): Promise<void> => {
    if (
      lockedRef.current?.identity === identity ||
      currentControlConnectionEpoch() !== identity.connectionEpoch
    ) {
      return;
    }
    const request = { id: ++sequenceRef.current, identity };
    lockedRef.current = request;
    latestRef.current = request;
    setPending({ ...request, label });
    setResultState(undefined);
    setFailure(undefined);
    try {
      const value = await task();
      if (
        mountedRef.current &&
        identityRef.current === identity &&
        currentControlConnectionEpoch() === identity.connectionEpoch &&
        latestRef.current === request
      ) {
        setResultState({ identity, value });
      }
    } catch (caught) {
      if (
        mountedRef.current &&
        identityRef.current === identity &&
        currentControlConnectionEpoch() === identity.connectionEpoch &&
        latestRef.current === request
      ) {
        setFailure({ identity, message: errorMessage(caught) });
      }
    } finally {
      if (lockedRef.current === request) lockedRef.current = undefined;
      if (mountedRef.current) {
        setPending((current) => (current?.id === request.id ? undefined : current));
      }
    }
  };

  const reject = (message: string): void => {
    if (currentControlConnectionEpoch() !== identity.connectionEpoch) return;
    latestRef.current = undefined;
    lockedRef.current = undefined;
    setPending(undefined);
    setResultState(undefined);
    setFailure({ identity, message });
  };

  return {
    busy: pending?.identity === identity ? pending.label : '',
    error: failure?.identity === identity ? failure.message : '',
    result: resultState?.identity === identity ? resultState.value : undefined,
    reject,
    run,
  };
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
