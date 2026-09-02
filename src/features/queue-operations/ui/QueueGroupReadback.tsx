import { Link } from 'react-router-dom';
import type { QueueGroupSnapshot } from '../application/QueueOperationsRepository';

export function QueueGroupReadback({ snapshot }: { snapshot: QueueGroupSnapshot }) {
  return (
    <>
      <dl className="mt-4 grid grid-cols-2 gap-3 rounded-lg border border-line p-3 text-xs sm:grid-cols-4 xl:grid-cols-7">
        <Readback label="Jobs" value={snapshot.jobs} />
        <Readback label="Active" value={snapshot.active} />
        <Readback label="All grouped" value={snapshot.totalGrouped} />
        <Readback
          label="Rate"
          value={
            snapshot.rateLimit
              ? `${snapshot.rateLimit.max}/${snapshot.rateLimit.duration}ms`
              : 'None'
          }
        />
        <Readback label="TTL" value={`${snapshot.rateLimitTtl} ms`} />
        <Readback label="Concurrency" value={snapshot.concurrency ?? 'None'} />
        <Readback label="Paused" value={snapshot.paused ? 'Yes' : 'No'} />
        <Readback label="Priority counts" value={prioritySummary(snapshot.priorityCounts)} />
      </dl>
      <div className="mt-3 overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-line text-faint">
            <tr>
              <th className="px-3 py-2 font-medium">Pending group job</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 text-right font-medium">Priority</th>
              <th className="px-3 py-2 text-right font-medium">Delay</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.entries.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-faint">
                  No pending jobs in this page.
                </td>
              </tr>
            ) : (
              snapshot.entries.map((job) => (
                <tr key={job.id} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 font-mono">
                    <Link
                      to={`/job?id=${encodeURIComponent(job.id)}`}
                      aria-label={`Inspect grouped job ${job.id}`}
                      className="text-accent hover:underline"
                    >
                      {job.id}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-fg">{job.name}</td>
                  <td className="px-3 py-2 text-right font-mono">{job.priority}</td>
                  <td className="px-3 py-2 text-right font-mono">{job.delay} ms</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Readback({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-faint">{label}</dt>
      <dd className="mt-1 font-mono text-fg">{value}</dd>
    </div>
  );
}

const prioritySummary = (counts: Record<string, number>) => {
  const entries = Object.entries(counts).sort(([left], [right]) => Number(left) - Number(right));
  return entries.length
    ? entries.map(([priority, count]) => `${priority}: ${count}`).join(' · ')
    : 'None';
};
