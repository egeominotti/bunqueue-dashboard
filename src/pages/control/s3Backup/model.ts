import type { BackupSchedule, S3AddressingStyle } from '@/components/dashboard/stores/s3Store';

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

export const storageTargetIdentity = (state: { baseUrl: string; token: string }) =>
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
