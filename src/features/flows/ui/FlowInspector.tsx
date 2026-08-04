import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import type { JobFull } from '@/lib/bqTypes';
import { MAX_FLOW_DEPTH, MAX_FLOW_NODES } from '../domain/flowConstants';
import type { Graph } from '../domain/flowSnapshot';

export function FlowInspector({ graph, selected }: { graph: Graph; selected: string | null }) {
  const job = selected ? graph.jobs.get(selected) : undefined;
  const failure = selected ? graph.failures.get(selected) : undefined;
  return (
    <aside aria-label="Selected job details" aria-live="polite">
      <Card>
        {job ? (
          <JobFacts job={job} failure={failure} />
        ) : (
          <p className="text-sm text-muted">Select a node to inspect it.</p>
        )}
        <FlowDiagnostics graph={graph} />
      </Card>
    </aside>
  );
}

function JobFacts({ job, failure }: { job: JobFull; failure?: string }) {
  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="text-xs text-faint">Job</div>
        <div translate="no" className="break-all font-mono text-xs text-fg">
          {job.id}
        </div>
      </div>
      {failure && (
        <p role="alert" className="break-words text-xs text-warning">
          Snapshot unavailable: {failure}
        </p>
      )}
      <Field label="Queue" value={job.queue ?? '—'} />
      <Field label="State" value={failure ? 'unavailable' : (job.state ?? 'unknown')} />
      <Field label="Priority" value={job.priority === undefined ? '—' : String(job.priority)} />
      <Field label="Parent" value={job.parentId ?? '—'} />
      <Field label="Children" value={failure ? '—' : String(job.childrenIds?.length ?? 0)} />
      <Field label="Depends on" value={failure ? '—' : String(job.dependsOn?.length ?? 0)} />
      <Link
        to={`/job?id=${encodeURIComponent(job.id)}`}
        className="inline-block rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
      >
        Open in Job Inspector
      </Link>
    </div>
  );
}

function FlowDiagnostics({ graph }: { graph: Graph }) {
  return (
    <div className="mt-4 border-t border-line pt-3 text-xs text-faint" aria-live="polite">
      {graph.truncated && (
        <div className="mb-1 text-warning">
          Graph truncated at {MAX_FLOW_NODES} nodes / depth {MAX_FLOW_DEPTH}.
        </div>
      )}
      <DiagnosticList
        label="known snapshot limitation"
        pluralLabel="known snapshot limitations"
        values={graph.limitations}
        tone="text-warning"
      />
      <DiagnosticList
        label="unavailable node"
        pluralLabel="unavailable nodes"
        values={[...graph.failures].map(([id, reason]) => `${id}: ${reason}`)}
        tone="text-warning"
      />
      {graph.cycle && (
        <div className="mb-1 break-words text-danger">
          Dependency cycle: <span className="font-mono">{graph.cycle.join(' → ')}</span>
        </div>
      )}
      <DiagnosticList
        label="snapshot inconsistency"
        pluralLabel="snapshot inconsistencies"
        values={graph.issues}
        tone="text-warning"
      />
      {graph.policyNotes.length > 0 && (
        <p className="mb-1 text-muted">
          Failure-policy notes are informational; the HTTP snapshot cannot prove that a policy
          fired.
        </p>
      )}
      <DiagnosticList
        label="failure-policy ambiguity"
        pluralLabel="failure-policy ambiguities"
        values={graph.policyNotes}
        tone="text-muted"
      />
      <div className="mb-1">
        {graph.jobs.size} nodes · {graph.edges.length} edges
      </div>
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1">
          <span className="inline-block h-px w-4 bg-current" /> child
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-px w-4 border-t border-dashed border-current" /> depends
        </span>
      </div>
    </div>
  );
}

function DiagnosticList({
  label,
  pluralLabel,
  values,
  tone,
}: {
  label: string;
  pluralLabel: string;
  values: string[];
  tone: string;
}) {
  if (!values.length) return null;
  return (
    <details className={`mb-1 ${tone}`}>
      <summary className="cursor-pointer">
        {values.length} {values.length === 1 ? label : pluralLabel}
      </summary>
      <ul className="mt-1 space-y-1 pl-3">
        {values.map((value) => (
          <li key={value} className="break-words">
            {value}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-2">
      <span className="shrink-0 text-xs text-faint">{label}</span>
      <span className="min-w-0 break-all text-right text-fg">{value}</span>
    </div>
  );
}
