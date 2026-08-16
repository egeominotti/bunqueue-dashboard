import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  currentControlConnectionEpoch,
  useControlConnectionEpoch,
} from '@/lib/controlConnectionEpoch';
import { useControlActionGuard } from '@/lib/useControlActionGuard';

interface RequestIdentity {
  key: string;
  connectionEpoch: number;
}

interface ActiveRequest {
  id: number;
  identity: RequestIdentity;
}

interface PendingRequest extends ActiveRequest {
  exclusive: boolean;
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

export function useLatestFlowRequest<T>(contextKey: string, operationGroup = 'shared') {
  const connectionEpoch = useControlConnectionEpoch();
  const persistentLockKey = `flow-exclusive:${operationGroup}`;
  const actionGuard = useControlActionGuard(persistentLockKey);
  const identity = useMemo<RequestIdentity>(
    () => ({ key: contextKey, connectionEpoch }),
    [connectionEpoch, contextKey]
  );
  const identityRef = useRef(identity);
  const lockedRef = useRef<ActiveRequest | undefined>(undefined);
  const exclusiveRef = useRef<ActiveRequest | undefined>(undefined);
  const latestRef = useRef<ActiveRequest | undefined>(undefined);
  const sequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const [pending, setPending] = useState<PendingRequest>();
  const [resultState, setResultState] = useState<RequestValue<T>>();
  const [failure, setFailure] = useState<RequestFailure>();

  useLayoutEffect(() => {
    if (identityRef.current.connectionEpoch !== identity.connectionEpoch) {
      exclusiveRef.current = undefined;
    }
    identityRef.current = identity;
    lockedRef.current = undefined;
    latestRef.current = undefined;
  }, [identity]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lockedRef.current = undefined;
      exclusiveRef.current = undefined;
      latestRef.current = undefined;
    };
  }, []);

  const run = async (
    label: string,
    task: () => Promise<T>,
    options: { exclusive?: boolean } = {}
  ): Promise<void> => {
    const exclusive = options.exclusive === true;
    if (
      exclusiveRef.current ||
      lockedRef.current?.identity === identity ||
      currentControlConnectionEpoch() !== identity.connectionEpoch
    ) {
      return;
    }
    // Probe the module-global lease even for reads so an exclusive mutation
    // from an unmounted instance keeps blocking this operation group. Reads do
    // not retain the lease; exclusive work owns it through final settlement.
    const persistentLease = actionGuard.begin(persistentLockKey);
    if (!persistentLease) return;
    if (!exclusive) persistentLease.finish();
    const request = { id: ++sequenceRef.current, identity };
    if (exclusive) exclusiveRef.current = request;
    else lockedRef.current = request;
    latestRef.current = request;
    setPending({ ...request, exclusive, label });
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
      if (exclusive) persistentLease.finish();
      if (exclusiveRef.current === request) exclusiveRef.current = undefined;
      if (lockedRef.current === request) lockedRef.current = undefined;
      if (mountedRef.current) {
        setPending((current) => (current?.id === request.id ? undefined : current));
      }
    }
  };

  const reject = (message: string): void => {
    if (exclusiveRef.current || currentControlConnectionEpoch() !== identity.connectionEpoch)
      return;
    latestRef.current = undefined;
    lockedRef.current = undefined;
    setPending(undefined);
    setResultState(undefined);
    setFailure({ identity, message });
  };

  return {
    busy:
      (pending?.exclusive && pending.identity.connectionEpoch === identity.connectionEpoch) ||
      pending?.identity === identity
        ? pending.label
        : '',
    error: failure?.identity === identity ? failure.message : '',
    result: resultState?.identity === identity ? resultState.value : undefined,
    reject,
    run,
  };
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
