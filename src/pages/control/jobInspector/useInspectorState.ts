import { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import type { JobFull } from '@/lib/bqTypes';
import type { InspectorMessage, InspectorResult, JobLookupTarget, LookupMode } from './types';

const EMPTY_RESULT: InspectorResult = { fetched: false, value: undefined };

export function useInspectorState(initialCustomId: string | null, initialId: string | null) {
  const [idInput, setIdInput] = useState(initialCustomId ?? initialId ?? '');
  const [lookupBy, setLookupBy] = useState<LookupMode>(initialCustomId ? 'custom' : 'id');
  const [job, setJob] = useState<JobFull | null>(null);
  const [result, setResult] = useState<InspectorResult>(EMPTY_RESULT);
  // A failed result fetch is NOT "no result stored". Preserve the transport
  // error so the Result card does not assert a fact about missing data.
  const [resultError, setResultError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [msg, setMsg] = useState<InspectorMessage | null>(null);
  const [busy, setBusy] = useState(false);

  // Sequence guard (last-to-start wins) for concurrent Enter/click lookups.
  const lookupGen = useRef(0);
  const lookupAbort = useRef<AbortController | null>(null);
  const lookupIdentity = useRef<{ key: string; mode: LookupMode } | null>(null);
  const jobTarget = useRef<JobLookupTarget | null>(null);
  const internalEmptyUrlPending = useRef(false);
  const preservedEmptyLocationKey = useRef<string | null>(null);
  const mounted = useRef(false);
  const actionGen = useRef(0);
  const actionBusy = useRef(false);
  // Keep the mutation mutex held until the request that acquired it settles.
  const actionLockOwner = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    // Abort before an old-target response can publish into the new target's UI.
    const unsubscribe = useConnectionStore.subscribe((next, previous) => {
      if (next.baseUrl === previous.baseUrl && next.token === previous.token) return;
      lookupGen.current += 1;
      lookupAbort.current?.abort();
      lookupAbort.current = null;
      lookupIdentity.current = null;
      actionGen.current += 1;
      actionLockOwner.current = null;
      actionBusy.current = false;
      jobTarget.current = null;
      internalEmptyUrlPending.current = false;
      preservedEmptyLocationKey.current = null;
      setJob(null);
      setResult(EMPTY_RESULT);
      setResultError(null);
      setNotFound(false);
      setMsg(null);
      setLoading(false);
      setBusy(false);
    });

    return () => {
      mounted.current = false;
      unsubscribe();
      // Invalidate even when a fetch mock ignores abort.
      lookupGen.current += 1;
      lookupAbort.current?.abort();
      lookupAbort.current = null;
      lookupIdentity.current = null;
      actionGen.current += 1;
      actionLockOwner.current = null;
      actionBusy.current = false;
    };
  }, []);

  return {
    idInput,
    setIdInput,
    lookupBy,
    setLookupBy,
    job,
    setJob,
    result,
    setResult,
    resultError,
    setResultError,
    loading,
    setLoading,
    notFound,
    setNotFound,
    msg,
    setMsg,
    busy,
    setBusy,
    lookupGen,
    lookupAbort,
    lookupIdentity,
    jobTarget,
    internalEmptyUrlPending,
    preservedEmptyLocationKey,
    mounted,
    actionGen,
    actionBusy,
    actionLockOwner,
  };
}

export type InspectorState = ReturnType<typeof useInspectorState>;
