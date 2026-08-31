import { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import {
  type BackupSchedule,
  type S3AddressingStyle,
  useS3Store,
} from '@/components/dashboard/stores/s3Store';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field, Input, Label, Select } from '@/components/ui/form';
import { IconS3 } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { BackupOperationsPanel } from '@/features/backups/ui/BackupOperationsPanel';
import { bq } from '@/lib/bq';
import {
  buildS3Environment,
  parseStorageHealthResponse,
  storageTargetIdentity,
} from './s3Backup/model';
import { S3EnvironmentCard } from './s3Backup/S3EnvironmentCard';

export type { S3Draft } from './s3Backup/model';
export { buildS3Environment, parseStorageHealthResponse } from './s3Backup/model';

export function S3BackupPro() {
  const s3 = useS3Store();
  const targetIdentity = useConnectionStore(storageTargetIdentity);
  const [test, setTest] = useState<{ target: string; ok: boolean; msg: string } | null>(null);
  const [checkingTarget, setCheckingTarget] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const environment = buildS3Environment(s3);
  const visibleTest = test?.target === targetIdentity ? test : null;
  const checking = checkingTarget === targetIdentity;

  // A target identity change invalidates checks from the previous target.
  useEffect(() => {
    requestGeneration.current++;
    setTest(null);
    setCheckingTarget(null);
    return () => {
      // oxlint-disable-next-line react/exhaustive-deps -- the shared generation ref invalidates this request on cleanup
      requestGeneration.current++;
    };
  }, [targetIdentity]);
  const checkServerStorage = async () => {
    const target = targetIdentity;
    const generation = ++requestGeneration.current;
    setTest(null);
    setCheckingTarget(target);
    try {
      const r = await bq.storage();
      if (
        generation !== requestGeneration.current ||
        storageTargetIdentity(useConnectionStore.getState()) !== target
      ) {
        return;
      }
      const health = parseStorageHealthResponse(r);
      setTest({
        target,
        ok: !health.diskFull,
        msg: health.diskFull
          ? 'Server disk is full'
          : 'Server disk healthy — this does not validate the S3 credentials',
      });
    } catch (e) {
      if (
        generation !== requestGeneration.current ||
        storageTargetIdentity(useConnectionStore.getState()) !== target
      ) {
        return;
      }
      setTest({ target, ok: false, msg: (e as Error).message });
    } finally {
      if (generation === requestGeneration.current) setCheckingTarget(null);
    }
  };
  return (
    <div>
      <PageHeader
        title="S3 Backup Setup"
        description="Configure and operate Bunqueue 2.9.2 S3 backups."
      />
      <div className="mb-6 flex items-center justify-between rounded-xl border border-line bg-surface px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg bg-surface-2 text-faint">
            <IconS3 className="size-5" />
          </span>
          <div>
            <div className="font-semibold text-fg">
              {environment.ok ? 'Configuration draft complete' : 'Configuration draft incomplete'}
            </div>
            <div className="text-xs text-faint">
              {environment.ok
                ? s3.schedule === 'disabled'
                  ? 'Safe disable settings ready to apply'
                  : `Target: ${s3.bucket.trim()} · ready to apply`
                : 'Complete the required fields to generate server settings'}
            </div>
          </div>
        </div>
        <span
          className={
            environment.ok
              ? 'rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-success'
              : 'rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-warning'
          }
        >
          {environment.ok ? 'Ready' : 'Configure'}
        </span>
      </div>
      <div className="mb-6 rounded-lg border border-line bg-surface/60 px-4 py-2.5 text-xs text-faint">
        Apply the generated settings through the local control agent below, then restart Bunqueue.
        Status, object listing, manual backups, and guarded restores use the official Bunqueue CLI.
        Non-secret draft fields are stored locally; credentials remain in memory.
      </div>
      <Card className="mb-6">
        <h2 className="mb-1 text-base font-semibold text-fg">Connection Settings</h2>
        <p className="mb-4 text-xs text-faint">
          Works with AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces, and any S3-compatible
          provider.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Endpoint">
            <Input
              name="s3-endpoint"
              value={s3.endpoint}
              onChange={(e) => s3.set({ endpoint: e.target.value })}
              placeholder="https://s3.amazonaws.com"
              maxLength={2048}
              autoComplete="off"
              inputMode="url"
            />
          </Field>
          <Field label="Region">
            <Input
              name="s3-region"
              value={s3.region}
              onChange={(e) => s3.set({ region: e.target.value })}
              placeholder="us-east-1"
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <div className="md:col-span-2">
            <Field label="Bucket name">
              <Input
                name="s3-bucket"
                value={s3.bucket}
                onChange={(e) => s3.set({ bucket: e.target.value })}
                placeholder="my-bunqueue-backups"
                maxLength={255}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </div>
          <Field label="Access key ID">
            <Input
              name="s3-access-key-id"
              value={s3.accessKeyId}
              onChange={(e) => s3.set({ accessKeyId: e.target.value })}
              placeholder="AKIA…"
              maxLength={512}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Secret access key">
            <Input
              name="s3-secret-access-key"
              type="password"
              value={s3.secretAccessKey}
              onChange={(e) => s3.set({ secretAccessKey: e.target.value })}
              placeholder="••••••••••••••••"
              maxLength={2048}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <div className="md:col-span-2">
            <Field label="Session token (optional, for temporary STS credentials)">
              <Input
                name="s3-session-token"
                type="password"
                value={s3.sessionToken}
                onChange={(e) => s3.set({ sessionToken: e.target.value })}
                placeholder="Temporary AWS session token"
                maxLength={4096}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </div>
          <p className="-mt-2 text-xs text-faint md:col-span-2">
            Keys are kept in memory only and cleared on reload.
          </p>
          <div>
            <Label htmlFor="s3-backup-schedule">Backup interval</Label>
            <Select
              id="s3-backup-schedule"
              name="s3-backup-schedule"
              value={s3.schedule}
              onChange={(e) => s3.set({ schedule: e.target.value as BackupSchedule })}
              className="mt-1.5"
              title="Written to S3_BACKUP_ENABLED and S3_BACKUP_INTERVAL in the generated config"
              autoComplete="off"
            >
              <option value="disabled">Disabled</option>
              <option value="6h">Every 6 hours</option>
              <option value="12h">Every 12 hours</option>
              <option value="24h">Every 24 hours</option>
            </Select>
          </div>
          <Field label="Path prefix (optional)">
            <Input
              name="s3-path-prefix"
              value={s3.pathPrefix}
              onChange={(e) => s3.set({ pathPrefix: e.target.value })}
              placeholder="backups/production/"
              maxLength={1024}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <div>
            <Label htmlFor="s3-addressing-style">Addressing style</Label>
            <Select
              id="s3-addressing-style"
              name="s3-addressing-style"
              value={s3.virtualHostedStyle}
              onChange={(e) => s3.set({ virtualHostedStyle: e.target.value as S3AddressingStyle })}
              className="mt-1.5"
            >
              <option value="auto">Provider default</option>
              <option value="virtual-hosted">Virtual-hosted style</option>
              <option value="path-style">Path style</option>
            </Select>
          </div>
          <Field label="Backups to retain">
            <Input
              name="s3-retention"
              type="number"
              min={1}
              max={1_000_000}
              step={1}
              value={s3.retention}
              onChange={(e) => s3.set({ retention: Number(e.target.value) })}
              inputMode="numeric"
            />
          </Field>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button onClick={checkServerStorage}>
            {checking ? 'Checking server storage…' : 'Check server storage'}
          </Button>
          <span className="text-xs text-faint">
            This checks SQLite disk health only, not S3 connectivity.
          </span>
          {visibleTest && (
            <span
              role="status"
              className={visibleTest.ok ? 'text-xs text-success' : 'text-xs text-danger'}
            >
              {visibleTest.msg}
            </span>
          )}
        </div>
      </Card>

      <S3EnvironmentCard environment={environment} />
      <BackupOperationsPanel environmentText={environment.ok ? environment.value : undefined} />
    </div>
  );
}
