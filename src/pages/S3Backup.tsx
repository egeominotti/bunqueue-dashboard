import { Card, CardHeader } from '@/components/ui/Card';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { api } from '@/lib/api';
import { usePolledData } from '@/lib/usePolledData';

const ENV_VARS: Array<[string, string]> = [
  ['S3_BACKUP_ENABLED', 'Set to 1 to enable periodic backups'],
  ['S3_BUCKET', 'Target bucket name'],
  ['S3_REGION', 'Bucket region (default us-east-1)'],
  ['S3_ENDPOINT', 'Custom endpoint (for S3-compatible stores)'],
  ['S3_ACCESS_KEY_ID', 'Access key'],
  ['S3_SECRET_ACCESS_KEY', 'Secret key'],
  ['S3_BACKUP_INTERVAL', 'Interval in ms (default 21600000 = 6h)'],
  ['S3_BACKUP_RETENTION', 'Backups to keep (default 7)'],
];

export function S3Backup() {
  const { data, error, loading, refetch } = usePolledData(() => api.storage(), []);

  return (
    <div>
      {error && <OfflineBanner onRetry={refetch} />}
      <PageHeader title="S3 Backup" description="SQLite snapshot backups to object storage." live />

      <div className="mb-6 rounded-lg border border-line bg-surface/60 px-4 py-3 text-sm text-muted">
        S3 backup runs on the server and is configured via environment variables — it cannot be
        toggled from the dashboard. The status below reflects the connected server's storage.
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Storage status" />
          {loading && !data && !error ? (
            <LoadingState />
          ) : (
            <dl className="divide-y divide-line text-sm">
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-muted">Disk</dt>
                <dd
                  className={
                    data?.data?.diskFull
                      ? 'font-medium text-red-400'
                      : 'font-medium text-emerald-400'
                  }
                >
                  {data?.data?.diskFull ? 'Full' : 'Healthy'}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-muted">Error</dt>
                <dd className="font-mono text-xs text-fg">
                  {data?.data?.error ? String(data.data.error) : '—'}
                </dd>
              </div>
            </dl>
          )}
        </Card>

        <Card>
          <CardHeader title="Configuration (server env)" />
          <dl className="divide-y divide-line text-sm">
            {ENV_VARS.map(([name, desc]) => (
              <div key={name} className="flex items-center justify-between gap-4 py-2.5">
                <dt className="font-mono text-xs text-accent/90">{name}</dt>
                <dd className="text-right text-xs text-faint">{desc}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </div>
  );
}
