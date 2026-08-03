import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

export type BackupSchedule = 'disabled' | '6h' | '12h' | '24h';
export type S3AddressingStyle = 'auto' | 'virtual-hosted' | 'path-style';

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
  sessionToken: string;
  schedule: BackupSchedule;
  pathPrefix: string;
  virtualHostedStyle: S3AddressingStyle;
  retention: number;
  set: (patch: Partial<Omit<S3State, 'set'>>) => void;
}

export const S3_STORAGE_KEY = 'bq-dash-s3';
const S3_STORAGE_VERSION = 2;
const SCHEDULES: readonly BackupSchedule[] = ['disabled', '6h', '12h', '24h'];

const S3_DEFAULTS = {
  endpoint: '',
  region: 'us-east-1',
  bucket: '',
  schedule: 'disabled' as BackupSchedule,
  pathPrefix: '',
  virtualHostedStyle: 'auto' as S3AddressingStyle,
  retention: 7,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown, fallback: string, max: number): string {
  return typeof value === 'string' && value.length <= max ? value : fallback;
}

function safeSchedule(value: unknown): BackupSchedule {
  return SCHEDULES.includes(value as BackupSchedule) ? (value as BackupSchedule) : 'disabled';
}

function safeAddressingStyle(value: unknown): S3AddressingStyle {
  return value === 'virtual-hosted' || value === 'path-style' ? value : 'auto';
}

function safeRetention(value: unknown): number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 1_000_000
    ? value
    : S3_DEFAULTS.retention;
}

export type PersistedS3State = typeof S3_DEFAULTS;

/** Sanitize stale/user-controlled storage before UI string operations consume it. */
export function sanitizedPersistedS3State(value: unknown): PersistedS3State {
  const stored = isRecord(value) ? value : {};
  return {
    endpoint: safeString(stored.endpoint, S3_DEFAULTS.endpoint, 2_048),
    region: safeString(stored.region, S3_DEFAULTS.region, 128),
    bucket: safeString(stored.bucket, S3_DEFAULTS.bucket, 255),
    schedule: safeSchedule(stored.schedule),
    pathPrefix: safeString(stored.pathPrefix, S3_DEFAULTS.pathPrefix, 1_024),
    virtualHostedStyle: safeAddressingStyle(stored.virtualHostedStyle),
    retention: safeRetention(stored.retention),
  };
}

/**
 * The subset of state persisted to localStorage. Credentials
 * (accessKeyId/secretAccessKey) are deliberately EXCLUDED — an AWS secret in
 * plaintext-at-rest is readable by any same-origin XSS or browser extension and
 * never expires. Keys stay in memory for the session only.
 */
export function persistedS3State(
  s: S3State
): Omit<S3State, 'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'set'> {
  return sanitizedPersistedS3State(s);
}

function browserStorage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function sanitizeStoredEnvelope(raw: string): { hydration: string; canonical: string } | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const envelope = isRecord(parsed) ? parsed : {};
    const rawState = 'state' in envelope ? envelope.state : envelope;
    const state = sanitizedPersistedS3State(rawState);
    const version = typeof envelope.version === 'number' ? envelope.version : undefined;
    return {
      hydration: JSON.stringify({ state, ...(version === undefined ? {} : { version }) }),
      canonical: JSON.stringify({ state, version: S3_STORAGE_VERSION }),
    };
  } catch {
    return null;
  }
}

const resilientS3Storage: StateStorage = {
  getItem(name) {
    const storage = browserStorage();
    if (!storage) return null;
    let raw: string | null;
    try {
      raw = storage.getItem(name);
    } catch {
      return null;
    }
    if (raw === null || name !== S3_STORAGE_KEY) return raw;
    const sanitized = sanitizeStoredEnvelope(raw);
    if (!sanitized) {
      try {
        storage.removeItem(name);
      } catch {
        // Invalid optional storage falls back to safe defaults.
      }
      return null;
    }
    if (raw !== sanitized.canonical) {
      try {
        storage.setItem(name, sanitized.canonical);
      } catch {
        // Never retain a legacy credential-bearing blob just because its
        // canonical replacement could not be written.
        try {
          storage.removeItem(name);
        } catch {
          // Sanitized in-memory hydration remains safe either way.
        }
      }
    }
    return sanitized.hydration;
  },
  setItem(name, value) {
    try {
      browserStorage()?.setItem(name, value);
    } catch {
      // Storage is best-effort; keep the already-applied in-memory draft.
    }
  },
  removeItem(name) {
    try {
      browserStorage()?.removeItem(name);
    } catch {
      // Durable cleanup is best-effort.
    }
  },
};

export const useS3Store = create<S3State>()(
  persist(
    (set) => ({
      ...S3_DEFAULTS,
      accessKeyId: '',
      secretAccessKey: '',
      sessionToken: '',
      set: (patch) =>
        set((current) => {
          const next = { ...current, ...patch };
          return {
            ...sanitizedPersistedS3State(next),
            accessKeyId: safeString(next.accessKeyId, '', 512),
            secretAccessKey: safeString(next.secretAccessKey, '', 2_048),
            sessionToken: safeString(next.sessionToken, '', 4_096),
          };
        }),
    }),
    {
      name: S3_STORAGE_KEY,
      version: S3_STORAGE_VERSION,
      storage: createJSONStorage(() => resilientS3Storage),
      partialize: persistedS3State,
      migrate: sanitizedPersistedS3State,
      merge: (persisted, current) => ({
        ...current,
        ...sanitizedPersistedS3State(persisted),
        accessKeyId: '',
        secretAccessKey: '',
        sessionToken: '',
      }),
    }
  )
);
