import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { activateResultProfile } from './inspect';
import type { DiscoveryRow, ScanReport } from './model';

export function InspectJob({ row }: { row: DiscoveryRow }) {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Inspect job ${row.job.id}`}
        onClick={() => {
          try {
            activateResultProfile(row.source);
            navigate(`/job?id=${encodeURIComponent(row.job.id)}`);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Source profile changed.');
          }
        }}
      >
        {row.job.id}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </>
  );
}
export function ScanCoverage({ report }: { report: ScanReport }) {
  return (
    <Card>
      <div role="status" className="text-sm text-muted">
        {report.partial ? 'Partial scan' : 'Scan complete'} · {report.inspectedJobs} jobs inspected
        · {report.scannedQueues} queues · {report.requests} requests · {report.elapsedMs} ms. These
        offset-based live reads can change during scanning. Showing {report.rows.length} of{' '}
        {report.matches} observed matches (display cap: 500).
      </div>
      {report.limitsHit.length > 0 && (
        <p className="mt-2 text-sm text-warning">Limits reached: {report.limitsHit.join(', ')}.</p>
      )}
      <ul className="mt-2 space-y-1 text-xs text-muted">
        {report.coverage.map((item) => (
          <li key={item.profileId}>
            {item.profileName}: {item.status} · {item.queues}
            {item.discoveredQueues !== undefined ? ` of ${item.discoveredQueues}` : ''} queues ·{' '}
            {item.inspectedJobs} jobs. {item.errors.join(' ')}
          </li>
        ))}
      </ul>
    </Card>
  );
}
export function DiscoveryResults({ report }: { report: ScanReport }) {
  return (
    <>
      <ScanCoverage report={report} />
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Observed job matches</caption>
          <thead className="bg-surface-2 text-muted">
            <tr>
              {['Job ID', 'Profile', 'Queue', 'State', 'Name', 'Priority', 'Created'].map(
                (title) => (
                  <th key={title} scope="col" className="p-3">
                    {title}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr
                className="border-t border-line"
                key={JSON.stringify([row.source.id, row.queue, row.job.id])}
              >
                <td className="p-3">
                  <InspectJob row={row} />
                </td>
                <td className="p-3">{row.source.name}</td>
                <td className="p-3">{row.queue}</td>
                <td className="p-3">{row.state}</td>
                <td className="p-3">{row.job.name ?? '—'}</td>
                <td className="p-3">{row.job.priority ?? '—'}</td>
                <td className="p-3">
                  {row.job.createdAt ? new Date(row.job.createdAt).toLocaleString() : 'Unknown'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {report.rows.length === 0 && (
          <p className="p-5 text-sm text-muted">No matches observed in scanned coverage.</p>
        )}
      </div>
    </>
  );
}
