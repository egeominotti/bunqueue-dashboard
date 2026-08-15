import { useEffect, useMemo, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconCron } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { bq } from '@/lib/bq';
import { usePolledData } from '@/lib/usePolledData';
import { useServerActionGuard } from '@/lib/useServerActionGuard';
import { CronForm } from './cron/CronForm';
import { CRON_PAGE_SIZE, CronTable } from './cron/CronTable';
import { useClampedPage } from './cron/hooks';
import { assertCronDeleteResponse, assertCronNameAvailable } from './cron/model';

export { useClampedPage, useTransientFlag } from './cron/hooks';
export type { CronFormValues } from './cron/model';
export {
  assertCronCreateResponse,
  assertCronDeleteResponse,
  assertCronNameAvailable,
  buildCronBody,
  existingCronNameError,
} from './cron/model';

export function CronManager() {
  const { data, error, loading, refetch } = usePolledData(() => bq.crons(), []);
  const crons = data?.crons ?? [];
  const existingNames = useMemo(() => new Set(crons.map((cron) => cron.name)), [crons]);
  const pageCount = Math.max(1, Math.ceil(crons.length / CRON_PAGE_SIZE));
  const [safePage, setPage] = useClampedPage(pageCount);
  const [actionError, setActionError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const actionGuard = useServerActionGuard('cron-manager');

  // scopeKey is the connection lifecycle boundary.
  useEffect(() => {
    setActionError(null);
    setRemoving(new Set());
  }, [actionGuard.scopeKey]);

  const remove = async (name: string) => {
    if (
      !window.confirm(
        `Delete cron "${name}"? It will not be recreated automatically; creating a replacement is a separate action.`
      )
    ) {
      return;
    }
    const lease = actionGuard.begin(`cron:${name}`);
    if (!lease) return;
    setActionError(null);
    setRemoving((current) => new Set(current).add(name));
    try {
      assertCronDeleteResponse(await bq.deleteCron(name));
      if (!lease.isCurrent()) return;
      toast.success('Cron deleted', name);
      void refetch();
    } catch (caught) {
      if (!lease.isCurrent()) return;
      setActionError((caught as Error).message);
      toast.error('Delete cron failed', (caught as Error).message);
    } finally {
      if (lease.finish()) {
        setRemoving((current) => {
          const next = new Set(current);
          next.delete(name);
          return next;
        });
      }
    }
  };

  return (
    <div>
      {error && data && (
        <OfflineBanner
          message="Cron refresh failed — showing the last successful schedule list."
          onRetry={refetch}
        />
      )}
      <PageHeader
        title="Cron Manager"
        description="Submit explicitly acknowledged schedule upserts and manage repeatable jobs."
        live={Boolean(data) && !error}
      />
      {actionError && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2 text-sm text-danger"
        >
          {actionError}
        </div>
      )}

      <Card className="mb-6">
        <CardHeader title="Create schedule via upstream upsert" />
        <CronForm
          existingNames={existingNames}
          onCreate={async (body, isCurrent) => {
            const latest = await bq.crons();
            if (!isCurrent()) throw new Error('Cron creation target changed during preflight');
            assertCronNameAvailable(latest, body.name);
            return bq.createCron(body);
          }}
          onAccepted={refetch}
          beginCreate={(name) => actionGuard.begin(`cron:${name}`)}
          scopeKey={actionGuard.scopeKey}
        />
      </Card>

      {error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingState label="Loading crons…" />
      ) : crons.length === 0 ? (
        <EmptyState icon={<IconCron />} title="No scheduled jobs" hint="Submit one above." />
      ) : (
        <CronTable
          crons={crons}
          page={safePage}
          removing={removing}
          onPageChange={setPage}
          onRemove={(name) => void remove(name)}
        />
      )}
    </div>
  );
}
