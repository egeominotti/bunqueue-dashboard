import { BqError } from '@/lib/bq';
import { opaqueHttpPathSegment } from '@/lib/upstreamPaths';
import {
  currentJobLookupTarget,
  loadJobForLookup,
  lookupGet,
  sameJobLookupTarget,
} from './jobLookup';
import { resultFromEnvelope } from './jobValidation';
import type { LookupMode, SetSearchParams } from './types';
import type { InspectorState } from './useInspectorState';

export type JobLookup = (
  raw: string,
  mode?: LookupMode,
  keepMessage?: boolean,
  actionOwner?: number,
  routeDriven?: boolean
) => Promise<void>;

export function createJobLookup(state: InspectorState, setParams: SetSearchParams): JobLookup {
  return async (
    raw,
    mode = state.lookupBy,
    keepMessage = false,
    actionOwner = undefined,
    routeDriven = false
  ) => {
    const key = raw.trim();
    if (!key) return;
    // User controls cannot release the mutation mutex while a mutation is
    // pending. URL navigation may supersede the display, but not the lock.
    if (actionOwner === undefined && state.actionBusy.current && !routeDriven) return;
    state.internalEmptyUrlPending.current = false;
    state.preservedEmptyLocationKey.current = null;
    if (actionOwner === undefined) state.actionGen.current += 1;

    // A lookup for another identity immediately revokes the rendered snapshot.
    const replacesDisplayedJob =
      state.job !== null && (mode === 'id' ? state.job.id !== key : state.job.customId !== key);
    if (replacesDisplayedJob) {
      state.jobTarget.current = null;
      state.setJob(null);
      state.setResult({ fetched: false, value: undefined });
      state.setResultError(null);
    }

    state.lookupAbort.current?.abort();
    const controller = new AbortController();
    state.lookupAbort.current = controller;
    state.lookupIdentity.current = { key, mode };
    const generation = ++state.lookupGen.current;
    const target = currentJobLookupTarget();
    state.setLoading(true);
    state.setNotFound(false);
    // Preserve the mutation success line during its read-back.
    if (!keepMessage) state.setMsg(null);

    try {
      const loaded = await loadJobForLookup(key, mode, {
        signal: controller.signal,
        target,
      });
      // A valid empty envelope is a not-found, not a rendering failure.
      if (!loaded) {
        if (generation !== state.lookupGen.current) return;
        state.internalEmptyUrlPending.current = true;
        state.preservedEmptyLocationKey.current = null;
        state.setJob(null);
        state.setResult({ fetched: false, value: undefined });
        state.setResultError(null);
        state.setNotFound(true);
        setParams({}, { replace: true });
        return;
      }

      // Bunqueue 2.9.2 embeds terminal values in canonical reads. Keep the
      // legacy result endpoint fallback for older compatible servers.
      let resultResponse: { result: unknown } | null = null;
      let resultError: string | null = null;
      if (
        generation !== state.lookupGen.current ||
        controller.signal.aborted ||
        !sameJobLookupTarget(target, currentJobLookupTarget())
      ) {
        return;
      }
      if (loaded.state === 'completed') {
        if (Object.hasOwn(loaded, 'returnvalue')) {
          resultResponse = { result: loaded.returnvalue };
        } else {
          try {
            const envelope = await lookupGet<unknown>(
              target,
              `/jobs/${opaqueHttpPathSegment(loaded.id)}/result`,
              controller.signal
            );
            resultResponse = resultFromEnvelope(envelope, loaded.id);
          } catch (error) {
            if (controller.signal.aborted) throw error;
            resultError = (error as Error).message;
          }
        }
      }
      if (
        generation !== state.lookupGen.current ||
        controller.signal.aborted ||
        !sameJobLookupTarget(target, currentJobLookupTarget())
      ) {
        return;
      }

      state.jobTarget.current = target;
      state.setJob(loaded);
      if (mode === 'custom') {
        // The input now contains the canonical id; align its lookup mode.
        state.setLookupBy('id');
        state.setIdInput(loaded.id);
      } else {
        state.setIdInput(key);
      }
      setParams({ id: loaded.id }, { replace: true });
      state.setResult(
        resultResponse
          ? { fetched: true, value: resultResponse.result }
          : { fetched: false, value: undefined }
      );
      state.setResultError(resultError);
    } catch (error) {
      if (generation !== state.lookupGen.current || controller.signal.aborted) return;
      // HTTP 404 and Bunqueue's HTTP-200 not-found envelope are both missing.
      if (error instanceof BqError && (error.status === 404 || /not found/i.test(error.message))) {
        state.internalEmptyUrlPending.current = true;
        state.preservedEmptyLocationKey.current = null;
        state.setJob(null);
        state.setResult({ fetched: false, value: undefined });
        state.setResultError(null);
        state.setNotFound(true);
        // Clear stale params so the route effect cannot fetch the previous job.
        setParams({}, { replace: true });
      } else if (keepMessage) {
        // The mutation was accepted; report read-back failure alongside it.
        state.setMsg((message) =>
          message
            ? {
                ok: message.ok,
                text: `${message.text} — couldn't reload: ${(error as Error).message}`,
              }
            : { ok: false, text: (error as Error).message }
        );
      } else {
        state.setMsg({ ok: false, text: (error as Error).message });
      }
    } finally {
      if (generation === state.lookupGen.current) {
        if (state.lookupAbort.current === controller) {
          state.lookupAbort.current = null;
          state.lookupIdentity.current = null;
        }
        state.setLoading(false);
      }
    }
  };
}
