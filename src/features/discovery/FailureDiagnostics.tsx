import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { DiscoveryFilters } from './DiscoveryFilters';
import { InspectJob, ScanCoverage } from './DiscoveryResults';
import { groupFailures } from './failureGroups';
import { queryFromSearch, queryToSearch } from './savedViews';
import { useDiscovery } from './useDiscovery';

export function FailureDiagnostics() {
  const [params, setParams] = useSearchParams();
  const query = { ...queryFromSearch(params.toString()), state: 'failed', includeDlq: true };
  const { report, loading, reload } = useDiscovery(query);
  const groups = groupFailures(report?.rows ?? []);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Failure diagnostics"
        description="Observed failed jobs and DLQ entries grouped by normalized error text and first stack line. Correlation is evidence, not a root-cause conclusion."
        actions={<Button onClick={reload}>Scan again</Button>}
      />
      <DiscoveryFilters
        query={query}
        failures
        onChange={(next) => setParams(queryToSearch(next))}
      />
      {loading && <LoadingState label="Scanning failures and DLQ entries…" />}
      {report && <ScanCoverage report={report} />}
      {report && (
        <p className="text-xs text-muted">
          Groups reflect the displayed sample of at most 500 matching jobs. Open a job to inspect
          its original details and logs.
        </p>
      )}
      {groups.map((group) => (
        <Card key={group.signature}>
          <CardHeader title={`${group.count} observed · ${group.message}`} />
          {group.firstStackLine && (
            <pre className="whitespace-pre-wrap break-words text-xs text-muted">
              {group.firstStackLine}
            </pre>
          )}
          <p className="mt-2 text-sm text-muted">
            Profiles: {group.profiles.join(', ')} · Queues: {group.queues.join(', ')} · Last
            observed failure:{' '}
            {group.lastObservedAt === undefined
              ? 'Unknown'
              : new Date(group.lastObservedAt).toLocaleString()}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
            Example jobs:{' '}
            {group.examples.map((row) => (
              <InspectJob key={JSON.stringify([row.source.id, row.queue, row.job.id])} row={row} />
            ))}
          </div>
        </Card>
      ))}
      {report && groups.length === 0 && (
        <p className="text-sm text-muted">No failures observed in scanned coverage.</p>
      )}
    </div>
  );
}
