import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import type { JobFull } from '@/lib/bqTypes';

/**
 * The inspector's single Data surface: an editable JSON view of the job's
 * payload (the textarea doubles as the read view — no separate read-only card).
 * Parses locally (inline error on bad JSON) and hands the parsed value to the
 * parent, which performs the actual
 * `PUT /jobs/:id/data` (bq.updateJobData) through its shared act() flow so
 * success/failure surfaces in the inspector's single status line and the job is
 * reloaded. The textarea re-seeds whenever the loaded job's data changes.
 */
export function JobDataEditor({
  data,
  busy,
  editable,
  readOnlyReason,
  onSave,
}: {
  data: JobFull['data'];
  busy: boolean;
  editable: boolean;
  readOnlyReason?: string;
  onSave: (parsed: unknown) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(data ?? null, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const lastSeed = useRef(text);

  useEffect(() => {
    const seed = JSON.stringify(data ?? null, null, 2);
    // Re-seed by CONTENT, not object identity: every act() (Set priority,
    // Retry, Promote…) reloads the job and produces a new `data` reference
    // with the same payload — that must not wipe unsaved edits.
    if (seed === lastSeed.current) return;
    lastSeed.current = seed;
    setText(seed);
    setParseError(null);
  }, [data]);

  const save = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setParseError(`Invalid JSON: ${(e as Error).message}`);
      return;
    }
    setParseError(null);
    onSave(parsed);
  };

  return (
    <Card>
      <CardHeader
        title="Data"
        action={
          editable ? (
            <Button size="sm" disabled={busy} onClick={save}>
              Save data
            </Button>
          ) : undefined
        }
      />
      <textarea
        aria-label="Job data JSON"
        name="job-data-json"
        value={text}
        onChange={(e) => setText(e.target.value)}
        readOnly={!editable}
        spellCheck={false}
        rows={8}
        className="w-full resize-y rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
      />
      {!editable && (
        <p className="mt-2 text-xs text-faint">
          {readOnlyReason ??
            'Data is read-only after a job starts processing or leaves the runnable queue.'}
        </p>
      )}
      {parseError && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {parseError}
        </p>
      )}
    </Card>
  );
}

/** States whose job is present in the runnable heap used by UpdateJobData. */
export function canEditJobData(state: string | undefined): boolean {
  return state === 'waiting' || state === 'prioritized' || state === 'delayed';
}

const FLOW_DATA_KEYS = [
  '__parentId',
  '__parentQueue',
  '__childrenIds',
  '__flowParentId',
  '__flowParentIds',
] as const;

/**
 * v2.8.57's UpdateJobData replaces the complete payload. FlowProducer stores
 * topology in reserved data keys as well as the public parent/children fields,
 * so a normal JSON edit would silently make FlowReader reject the graph.
 */
export function jobDataReadOnlyReason(
  state: string | undefined,
  job: Pick<JobFull, 'data' | 'parentId' | 'childrenIds'>
): string | null {
  if (!canEditJobData(state)) {
    return 'Data is read-only after a job starts processing or leaves the runnable queue.';
  }

  const data = job.data;
  const hasReservedFlowData =
    data !== null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    FLOW_DATA_KEYS.some((key) => Object.hasOwn(data, key));
  if (job.parentId || (job.childrenIds?.length ?? 0) > 0 || hasReservedFlowData) {
    return 'Data is read-only for Flow jobs because Bunqueue v2.8.57 replaces the full payload and would remove structural metadata.';
  }
  return null;
}
