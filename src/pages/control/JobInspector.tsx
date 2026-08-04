import { useLocation, useSearchParams } from 'react-router-dom';
import { getBaseUrl, useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { BqError } from '@/lib/bq';
import { createJobLookup } from './jobInspector/createJobLookup';
import { JobInspectorContent } from './jobInspector/JobInspectorContent';
import { JobInspectorHeader } from './jobInspector/JobInspectorHeader';
import { currentJobLookupTarget, sameJobLookupTarget } from './jobInspector/jobLookup';
import type { JobAction, LookupMode } from './jobInspector/types';
import { useInspectorRoute } from './jobInspector/useInspectorRoute';
import { useInspectorState } from './jobInspector/useInspectorState';

export { loadJobForLookup } from './jobInspector/jobLookup';
export {
  buildStacktracePreview,
  type StacktracePreview,
} from './jobInspector/jobValidation';
export type {
  JobLookupOptions,
  JobLookupTarget,
  LookupMode,
} from './jobInspector/types';

export function JobInspector() {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const connectionBaseUrl = useConnectionStore((value) => value.baseUrl);
  const connectionToken = useConnectionStore((value) => value.token);
  const initialCustomId = params.get('custom');
  const state = useInspectorState(initialCustomId, params.get('id'));
  const lookup = createJobLookup(state, setParams);

  const idParam = params.get('id');
  const customParam = params.get('custom');
  const renderedTarget = {
    // The selector triggers this render; getBaseUrl supplies canonical form.
    baseUrl: getBaseUrl(),
    authorization: connectionToken ? `Bearer ${connectionToken}` : undefined,
  };
  const jobBelongsToCurrentTarget = sameJobLookupTarget(state.jobTarget.current, renderedTarget);

  useInspectorRoute({
    state,
    lookup,
    setParams,
    locationKey: location.key,
    idParam,
    customParam,
    jobBelongsToCurrentTarget,
    connectionBaseUrl,
    connectionToken,
  });

  const submitLookup = (raw: string, mode: LookupMode = state.lookupBy) => {
    const key = raw.trim();
    if (!key || state.actionBusy.current) return;
    const routeAlreadyOwnsLookup =
      mode === 'id'
        ? idParam === key && customParam === null
        : customParam === key && idParam === null;
    if (routeAlreadyOwnsLookup) {
      // A retry for the current route does not require a navigation event.
      void lookup(key, mode);
      return;
    }
    // The URL owns identity and the route effect owns cross-job lookups.
    setParams(mode === 'custom' ? { custom: key } : { id: key });
  };

  const act: JobAction = async (label, operation, confirmMessage) => {
    // A ref closes the same-tick double-click window before state can render.
    if (!state.job || state.actionBusy.current || state.lookupAbort.current) return;
    const target = currentJobLookupTarget();
    if (!sameJobLookupTarget(state.jobTarget.current, target)) return;
    if (confirmMessage && !window.confirm(confirmMessage)) return;

    const generation = ++state.actionGen.current;
    const actionJobId = state.job.id;
    state.actionLockOwner.current = generation;
    state.actionBusy.current = true;
    state.setBusy(true);
    state.setMsg(null);

    const isCurrent = () =>
      state.mounted.current &&
      generation === state.actionGen.current &&
      sameJobLookupTarget(target, currentJobLookupTarget()) &&
      sameJobLookupTarget(state.jobTarget.current, target);

    try {
      const accepted = await operation();
      if (
        !accepted ||
        typeof accepted !== 'object' ||
        Array.isArray(accepted) ||
        (accepted as { ok?: unknown }).ok !== true
      ) {
        throw new BqError('Invalid job mutation response: expected { ok: true }', 200);
      }
      if (!isCurrent()) return;
      state.setMsg({ ok: true, text: `${label} ✓` });
      if (label === 'Cancel') {
        state.internalEmptyUrlPending.current = true;
        state.preservedEmptyLocationKey.current = null;
        state.lookupGen.current += 1;
        state.jobTarget.current = null;
        state.setJob(null);
        state.setResult({ fetched: false, value: undefined });
        state.setResultError(null);
        // Prevent the route effect from fetching the just-deleted job again.
        setParams({}, { replace: true });
      } else {
        await lookup(actionJobId, 'id', true, generation);
      }
    } catch (error) {
      if (isCurrent()) state.setMsg({ ok: false, text: (error as Error).message });
    } finally {
      if (state.actionLockOwner.current === generation) {
        state.actionLockOwner.current = null;
        state.actionBusy.current = false;
        if (state.mounted.current) state.setBusy(false);
      }
    }
  };

  return (
    <div>
      <JobInspectorHeader
        job={state.job}
        result={state.result}
        idInput={state.idInput}
        lookupBy={state.lookupBy}
        loading={state.loading}
        busy={state.busy}
        onInputChange={state.setIdInput}
        onModeChange={state.setLookupBy}
        onSubmit={submitLookup}
      />

      {state.msg && (
        <div
          role="status"
          className={state.msg.ok ? 'mb-4 text-sm text-success' : 'mb-4 text-sm text-danger'}
        >
          {state.msg.text}
        </div>
      )}

      <JobInspectorContent
        job={state.job}
        result={state.result}
        resultError={state.resultError}
        loading={state.loading}
        notFound={state.notFound}
        busy={state.busy}
        lookup={lookup}
        act={act}
      />
    </div>
  );
}
