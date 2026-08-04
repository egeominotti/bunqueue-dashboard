import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/form';
import { IconDownload, IconSearch } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import type { JobFull } from '@/lib/bqTypes';
import { buildCloneState } from '@/lib/cloneJob';
import { downloadJson } from '@/lib/exportFile';
import type { InspectorResult, LookupMode } from './types';

interface JobInspectorHeaderProps {
  job: JobFull | null;
  result: InspectorResult;
  idInput: string;
  lookupBy: LookupMode;
  loading: boolean;
  busy: boolean;
  onInputChange: (value: string) => void;
  onModeChange: (mode: LookupMode) => void;
  onSubmit: (raw: string) => void;
}

export function JobInspectorHeader({
  job,
  result,
  idInput,
  lookupBy,
  loading,
  busy,
  onInputChange,
  onModeChange,
  onSubmit,
}: JobInspectorHeaderProps) {
  const hasFlowRelationship = Boolean(job && ((job.childrenIds?.length ?? 0) > 0 || job.parentId));

  return (
    <>
      <PageHeader
        title="Job Inspector"
        description="Look up any job by ID and drive its full lifecycle."
        actions={
          job ? (
            <>
              {hasFlowRelationship && (
                <Link
                  to={`/flows?root=${encodeURIComponent(job.id)}`}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
                >
                  View flow
                </Link>
              )}
              <Link
                to="/add-job"
                state={buildCloneState(job)}
                title="Enqueue a new job pre-filled from this one"
                className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
              >
                Clone
              </Link>
              <Button
                size="sm"
                onClick={() =>
                  downloadJson(
                    `job-${job.id}`,
                    result.fetched ? { ...job, result: result.value } : job
                  )
                }
              >
                <IconDownload className="size-3.5" /> Download JSON
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Select
          name="job-lookup-mode"
          autoComplete="off"
          value={lookupBy}
          aria-label="Lookup mode"
          onChange={(event) => onModeChange(event.target.value as LookupMode)}
          className="w-40"
        >
          <option value="id">By job ID</option>
          <option value="custom">By custom ID</option>
        </Select>
        <div className="relative min-w-56 flex-1">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            value={idInput}
            aria-label={lookupBy === 'custom' ? 'Custom job ID' : 'Job ID'}
            name="job-lookup-id"
            autoComplete="off"
            spellCheck={false}
            maxLength={1024}
            onInput={(event) => onInputChange(event.currentTarget.value)}
            onKeyDown={(event) => event.key === 'Enter' && onSubmit(idInput)}
            placeholder={
              lookupBy === 'custom'
                ? 'custom / idempotency id — Enter to look up'
                : 'job id (UUID) — Enter to look up'
            }
            className="h-9 w-full rounded-lg border border-line bg-surface pl-9 pr-3 font-mono text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>
        <Button variant="accent" disabled={loading || busy} onClick={() => onSubmit(idInput)}>
          Look up
        </Button>
      </div>
    </>
  );
}
