import { useState } from 'react';
import { type BackupSchedule, useS3Store } from '@/components/dashboard/stores/s3Store';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/feedback';
import { Field, Input, Label, Select } from '@/components/ui/form';
import { IconS3 } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { bq } from '@/lib/bq';

export function S3BackupPro() {
  const s3 = useS3Store();
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const configured = s3.bucket.trim() !== '';

  const testConnection = async () => {
    setTest(null);
    try {
      const r = await bq.storage();
      setTest({
        ok: !r.data?.diskFull,
        msg: r.data?.diskFull ? 'Server disk is full' : 'Server storage reachable',
      });
    } catch (e) {
      setTest({ ok: false, msg: (e as Error).message });
    }
  };

  return (
    <div>
      <PageHeader title="S3 Backup" description="Automatic backups to S3-compatible storage." />

      <div className="mb-6 flex items-center justify-between rounded-xl border border-line bg-surface px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg bg-surface-2 text-faint">
            <IconS3 className="size-5" />
          </span>
          <div>
            <div className="font-semibold text-fg">
              {configured ? 'Backup configured' : 'No backup configured'}
            </div>
            <div className="text-xs text-faint">
              {configured ? `Target: ${s3.bucket}` : 'Set up S3 to protect your queue data'}
            </div>
          </div>
        </div>
        <span
          className={
            configured
              ? 'rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-success'
              : 'rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-warning'
          }
        >
          {configured ? 'Ready' : 'Configure'}
        </span>
      </div>

      <div className="mb-6 rounded-lg border border-line bg-surface/60 px-4 py-2.5 text-xs text-faint">
        bunqueue reads S3 backup settings from server environment variables (S3_BUCKET, S3_REGION,
        …). This form helps you assemble that configuration; it is stored locally in your browser.
      </div>

      <Card className="mb-6">
        <h3 className="mb-1 text-base font-semibold text-fg">Connection Settings</h3>
        <p className="mb-4 text-xs text-faint">
          Works with AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces, and any S3-compatible
          provider.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Endpoint">
            <Input
              value={s3.endpoint}
              onChange={(e) => s3.set({ endpoint: e.target.value })}
              placeholder="https://s3.amazonaws.com"
            />
          </Field>
          <Field label="Region">
            <Input
              value={s3.region}
              onChange={(e) => s3.set({ region: e.target.value })}
              placeholder="us-east-1"
            />
          </Field>
          <div className="md:col-span-2">
            <Field label="Bucket name">
              <Input
                value={s3.bucket}
                onChange={(e) => s3.set({ bucket: e.target.value })}
                placeholder="my-bunqueue-backups"
              />
            </Field>
          </div>
          <Field label="Access key ID">
            <Input
              value={s3.accessKeyId}
              onChange={(e) => s3.set({ accessKeyId: e.target.value })}
              placeholder="AKIA…"
            />
          </Field>
          <Field label="Secret access key">
            <Input
              type="password"
              value={s3.secretAccessKey}
              onChange={(e) => s3.set({ secretAccessKey: e.target.value })}
              placeholder="••••••••••••••••"
            />
          </Field>
          <p className="-mt-2 text-xs text-faint md:col-span-2">
            Keys are kept in memory only and cleared on reload.
          </p>
          <div>
            <Label>Backup schedule</Label>
            <Select
              value={s3.schedule}
              onChange={(e) => s3.set({ schedule: e.target.value as BackupSchedule })}
              className="mt-1.5"
            >
              <option value="disabled">Disabled</option>
              <option value="6h">Every 6 hours</option>
              <option value="12h">Every 12 hours</option>
              <option value="24h">Every 24 hours</option>
            </Select>
          </div>
          <Field label="Path prefix (optional)">
            <Input
              value={s3.pathPrefix}
              onChange={(e) => s3.set({ pathPrefix: e.target.value })}
              placeholder="backups/production/"
            />
          </Field>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button
            variant="accent"
            onClick={() => {
              setSaved(true);
              setTimeout(() => setSaved(false), 2000);
            }}
          >
            Save Configuration
          </Button>
          <Button onClick={testConnection}>Test Connection</Button>
          <Button disabled title="Trigger a manual backup — requires server-side S3 config">
            Backup Now
          </Button>
          {saved && <span className="text-xs text-success">Saved locally (keys excluded)</span>}
          {test && (
            <span className={test.ok ? 'text-xs text-success' : 'text-xs text-danger'}>
              {test.msg}
            </span>
          )}
        </div>
      </Card>

      <Card>
        <h3 className="mb-4 text-base font-semibold text-fg">Backup History</h3>
        <EmptyState
          icon={<IconS3 />}
          title="No backups yet"
          hint="Configure your S3 connection and run a backup to get started."
        />
      </Card>
    </div>
  );
}
