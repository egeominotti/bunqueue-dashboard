import { Card } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';

export function S3EnvironmentCard({
  environment,
}: {
  environment: { ok: true; value: string } | { ok: false; errors: string[] };
}) {
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-fg">Server environment</h2>
          <p className="mt-1 text-xs text-faint">
            Credentials stay in memory and are copied or applied only when you request it.
          </p>
        </div>
        {environment.ok && <CopyButton value={environment.value} />}
      </div>
      {environment.ok ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 p-4 font-mono text-xs text-muted">
          {environment.value
            .replace(/^S3_ACCESS_KEY_ID=.*$/m, 'S3_ACCESS_KEY_ID="••••••••"')
            .replace(/^S3_SECRET_ACCESS_KEY=.*$/m, 'S3_SECRET_ACCESS_KEY="••••••••"')
            .replace(/^S3_SESSION_TOKEN=.*$/m, 'S3_SESSION_TOKEN="••••••••"')}
        </pre>
      ) : (
        <ul className="space-y-1 text-sm text-danger" aria-label="Configuration errors">
          {environment.errors.map((error) => (
            <li key={error}>• {error}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
