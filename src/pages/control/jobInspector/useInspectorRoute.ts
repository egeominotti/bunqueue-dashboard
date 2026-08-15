import { useEffect } from 'react';
import type { JobLookup } from './createJobLookup';
import type { SetSearchParams } from './types';
import type { InspectorState } from './useInspectorState';

interface InspectorRouteOptions {
  state: InspectorState;
  lookup: JobLookup;
  setParams: SetSearchParams;
  locationKey: string;
  idParam: string | null;
  customParam: string | null;
  jobBelongsToCurrentTarget: boolean;
  connectionBaseUrl: string;
  connectionToken: string;
}

export function useInspectorRoute({
  state,
  lookup,
  setParams,
  locationKey,
  idParam,
  customParam,
  jobBelongsToCurrentTarget,
  connectionBaseUrl,
  connectionToken,
}: InspectorRouteOptions): void {
  // URL and connection changes drive synchronization; lookup/state containers are render snapshots.
  /* oxlint-disable react/exhaustive-deps -- URL and connection changes intentionally drive synchronization */
  useEffect(() => {
    // Clearing a job can render once while its old ?id= remains visible. Bind
    // terminal feedback to that exact history entry instead of refetching it.
    if (state.internalEmptyUrlPending.current) {
      if (!idParam && !customParam) {
        state.internalEmptyUrlPending.current = false;
        state.preservedEmptyLocationKey.current = locationKey;
      }
      return;
    }
    if (!idParam && !customParam && state.preservedEmptyLocationKey.current === locationKey) {
      return;
    }
    state.preservedEmptyLocationKey.current = null;

    if (customParam) {
      if (state.job?.customId === customParam && jobBelongsToCurrentTarget) {
        // Avoid issuing the custom + canonical pair again while the router is
        // publishing the canonical ?id= URL from the completed lookup.
        state.setLookupBy('id');
        state.setIdInput(state.job.id);
        setParams({ id: state.job.id }, { replace: true });
      } else {
        state.setLookupBy('custom');
        state.setIdInput(customParam);
        const currentLookup = state.lookupIdentity.current;
        if (currentLookup?.mode !== 'custom' || currentLookup.key !== customParam) {
          void lookup(customParam, 'custom', false, undefined, true);
        }
      }
    } else if (idParam && (idParam !== state.job?.id || !jobBelongsToCurrentTarget)) {
      state.setLookupBy('id');
      state.setIdInput(idParam);
      const currentLookup = state.lookupIdentity.current;
      if (currentLookup?.mode !== 'id' || currentLookup.key !== idParam) {
        void lookup(idParam, 'id', false, undefined, true);
      }
    } else if (!idParam && !customParam) {
      // Removing the URL identity cancels all continuations and data ownership.
      state.lookupGen.current += 1;
      state.lookupAbort.current?.abort();
      state.lookupAbort.current = null;
      state.lookupIdentity.current = null;
      state.actionGen.current += 1;
      state.jobTarget.current = null;
      state.setJob(null);
      state.setResult({ fetched: false, value: undefined });
      state.setResultError(null);
      state.setNotFound(false);
      state.setMsg(null);
      state.setLoading(false);
      state.setLookupBy('id');
      state.setIdInput('');
    }
  }, [
    idParam,
    customParam,
    state.job?.id,
    state.job?.customId,
    jobBelongsToCurrentTarget,
    locationKey,
    connectionBaseUrl,
    connectionToken,
  ]);
  /* oxlint-enable react/exhaustive-deps */
}
