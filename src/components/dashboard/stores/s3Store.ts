import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type BackupSchedule = 'disabled' | '6h' | '12h' | '24h';

/**
 * S3 backup settings are stored client-side. bunqueue OSS configures S3 backup
 * via server environment variables (S3_BACKUP_ENABLED, S3_BUCKET, …), so this is
 * a helper to assemble that config — it is not pushed to the server at runtime.
 */
interface S3State {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  schedule: BackupSchedule;
  pathPrefix: string;
  set: (patch: Partial<Omit<S3State, 'set'>>) => void;
}

/**
 * The subset of state persisted to localStorage. Credentials
 * (accessKeyId/secretAccessKey) are deliberately EXCLUDED — an AWS secret in
 * plaintext-at-rest is readable by any same-origin XSS or browser extension and
 * never expires. Keys stay in memory for the session only.
 */
export function persistedS3State(
  s: S3State
): Omit<S3State, 'accessKeyId' | 'secretAccessKey' | 'set'> {
  return {
    endpoint: s.endpoint,
    region: s.region,
    bucket: s.bucket,
    schedule: s.schedule,
    pathPrefix: s.pathPrefix,
  };
}

export const useS3Store = create<S3State>()(
  persist(
    (set) => ({
      endpoint: '',
      region: 'us-east-1',
      bucket: '',
      accessKeyId: '',
      secretAccessKey: '',
      schedule: 'disabled',
      pathPrefix: '',
      set: (patch) => set(patch),
    }),
    { name: 'bq-dash-s3', partialize: persistedS3State }
  )
);
