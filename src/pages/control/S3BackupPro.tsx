import { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import {
  type BackupSchedule,
  type S3AddressingStyle,
  useS3Store,
} from '@/components/dashboard/stores/s3Store';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { Field, Input, Label, Select } from '@/components/ui/form';
import { IconS3 } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { bq } from '@/lib/bq';

export function parseStorageHealthResponse(value: unknown): { diskFull: boolean } {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as { ok?: unknown }).ok !== 'boolean'
  ) {
    throw new Error('Malformed storage status response.');
  }
  const data = (value as { data?: unknown }).data;
  if (
    data === null ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    typeof (data as { diskFull?: unknown }).diskFull !== 'boolean'
  ) {
    throw new Error('Storage status response is missing disk health data.');
  }
  return { diskFull: (data as { diskFull: boolean }).diskFull };
}

const storageTargetIdentity = (state: { baseUrl: string; token: string }) =>
  JSON.stringify([state.baseUrl, state.token]);

const SCHEDULE_INTERVAL: Record<Exclude<BackupSchedule, 'disabled'>, number> = {
  '6h': 6 * 60 * 60 * 1_000,
  '12h': 12 * 60 * 60 * 1_000,
  '24h': 24 * 60 * 60 * 1_000,
};

export interface S3Draft {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  schedule: BackupSchedule;
  pathPrefix: string;
  virtualHostedStyle: S3AddressingStyle;
  retention: number;
}

function envLine(key: string, value: string | number | boolean): string {
  return `${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`;
}

/** Build the actual v2.8.55 server environment, or explain why it is unsafe. */
export function buildS3Environment(
  draft: S3Draft
): { ok: true; value: string } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const endpoint = draft.endpoint.trim();
  const region = draft.region.trim();
  const bucket = draft.bucket.trim();
  const accessKeyId = draft.accessKeyId.trim();
  const secretAccessKey = draft.secretAccessKey.trim();
  const sessionToken = draft.sessionToken.trim();
  const pathPrefix = draft.pathPrefix.trim();
  // A disabled patch must be usable to stop backups even when old credentials
  // are unavailable. Do not require or repeat unrelated secrets in that case.
  if (draft.schedule === 'disabled') {
    return { ok: true, value: envLine('S3_BACKUP_ENABLED', false) };
  }
  if (!region || region.length > 128) errors.push('Region is required (maximum 128 characters).');
  if (!bucket || bucket.length > 255) errors.push('Bucket is required (maximum 255 characters).');
  if (!accessKeyId || accessKeyId.length > 512) {
    errors.push('Access key ID is required (maximum 512 characters).');
  }
  if (!secretAccessKey || secretAccessKey.length > 2_048) {
    errors.push('Secret access key is required (maximum 2048 characters).');
  }
  if (sessionToken.length > 4_096) errors.push('Session token is too long.');
  if (
    !Number.isSafeInteger(draft.retention) ||
    draft.retention < 1 ||
    draft.retention > 1_000_000
  ) {
    errors.push('Retention must be a whole number from 1 to 1000000.');
  }
  if (pathPrefix.length > 1_024) errors.push('Path prefix is too long.');
  if (endpoint) {
    try {
      const parsed = new URL(endpoint);
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.username ||
        parsed.password ||
        endpoint.length > 2_048
      ) {
        errors.push('Endpoint must be an http(s) URL without embedded credentials.');
      }
    } catch {
      errors.push('Endpoint must be a valid http(s) URL.');
    }
  }
  if (errors.length) return { ok: false, errors };

  const lines = [
    envLine('S3_BACKUP_ENABLED', true),
    envLine('S3_ACCESS_KEY_ID', accessKeyId),
    envLine('S3_SECRET_ACCESS_KEY', secretAccessKey),
    envLine('S3_BUCKET', bucket),
    envLine('S3_REGION', region),
    envLine('S3_BACKUP_RETENTION', draft.retention),
  ];
  if (sessionToken) lines.push(envLine('S3_SESSION_TOKEN', sessionToken));
  if (draft.virtualHostedStyle !== 'auto') {
    lines.push(envLine('S3_VIRTUAL_HOSTED_STYLE', draft.virtualHostedStyle === 'virtual-hosted'));
  }
  if (endpoint) lines.push(envLine('S3_ENDPOINT', endpoint));
  if (pathPrefix) lines.push(envLine('S3_BACKUP_PREFIX', pathPrefix));
  lines.push(envLine('S3_BACKUP_INTERVAL', SCHEDULE_INTERVAL[draft.schedule]));
  return { ok: true, value: lines.join('\n') };
}

export function S3BackupPro() {
  const s3 = useS3Store();
  const targetIdentity = useConnectionStore(storageTargetIdentity);
  const [test, setTest] = useState<{ target: string; ok: boolean; msg: string } | null>(null);
  const [checkingTarget, setCheckingTarget] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const environment = buildS3Environment(s3);
  const visibleTest = test?.target === targetIdentity ? test : null;
  const checking = checkingTarget === targetIdentity;

  // biome-ignore lint/correctness/useExhaustiveDependencies: target identity changes invalidate in-flight checks
  useEffect(() => {
    requestGeneration.current++;
    setTest(null);
    setCheckingTarget(null);
    return () => {
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
        description="Build the server-side configuration supported by Bunqueue v2.8.55."
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
                  ? 'Safe disable patch ready · not yet applied to the server'
                  : `Target: ${s3.bucket.trim()} · not yet applied to the server`
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
          {environment.ok ? 'Draft only' : 'Configure'}
        </span>
      </div>

      <div className="mb-6 rounded-lg border border-line bg-surface/60 px-4 py-2.5 text-xs text-faint">
        The dashboard cannot change a running Bunqueue server or verify S3 credentials. It generates
        the exact environment settings; apply them on the server, ensure persistent SQLite storage
        is configured, then restart Bunqueue. Non-secret draft fields are stored locally.
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

      <Card>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-fg">Server environment</h2>
            <p className="mt-1 text-xs text-faint">
              Credentials stay in memory and are copied only when you request it.
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
        <p className="mt-3 text-xs text-faint">
          Bunqueue v2.8.55 exposes no dashboard HTTP endpoint for S3 credential tests, manual
          backups, or backup history; those controls are deliberately not simulated here.
        </p>
      </Card>
    </div>
  );
}
