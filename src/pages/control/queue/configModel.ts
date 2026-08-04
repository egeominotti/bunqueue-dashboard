import type { DlqConfig, StallConfig } from '@/lib/bqTypes';

export function configSig(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    return JSON.stringify(
      Object.keys(object)
        .sort()
        .map((key) => [key, object[key]])
    );
  }
  return JSON.stringify(value);
}

function toSafeWhole(value: number | string, min: number): number | null {
  const raw = String(value).trim();
  if (raw === '') return null;
  const number = Number(raw);
  return Number.isSafeInteger(number) && number >= min ? number : null;
}

export type StallDraft = Omit<StallConfig, 'stallInterval' | 'maxStalls' | 'gracePeriod'> & {
  stallInterval: number | string;
  maxStalls: number | string;
  gracePeriod: number | string;
};

export type DlqDraft = Omit<
  DlqConfig,
  'autoRetryInterval' | 'maxAutoRetries' | 'maxAge' | 'maxEntries'
> & {
  autoRetryInterval: number | string;
  maxAutoRetries: number | string;
  maxAge: number | string | null;
  maxEntries: number | string;
};

export type ConfigValidation<T> = { ok: true; value: T } | { ok: false; error: string };

export function stallConfigPayload(config: StallDraft): ConfigValidation<StallConfig> {
  const stallInterval = toSafeWhole(config.stallInterval, 0);
  const maxStalls = toSafeWhole(config.maxStalls, 0);
  const gracePeriod = toSafeWhole(config.gracePeriod, 0);
  if (stallInterval === null || maxStalls === null || gracePeriod === null) {
    return {
      ok: false,
      error: 'Stall interval, max stalls, and grace period must be non-negative whole numbers.',
    };
  }
  return { ok: true, value: { enabled: config.enabled, stallInterval, maxStalls, gracePeriod } };
}

export function dlqConfigPayload(config: DlqDraft): ConfigValidation<DlqConfig> {
  const autoRetryInterval = toSafeWhole(config.autoRetryInterval, 0);
  const maxAutoRetries = toSafeWhole(config.maxAutoRetries, 0);
  const maxEntries = toSafeWhole(config.maxEntries, 1);
  const maxAgeRaw = config.maxAge == null ? '' : String(config.maxAge).trim();
  const maxAge = maxAgeRaw === '' ? null : toSafeWhole(maxAgeRaw, 0);
  if (
    autoRetryInterval === null ||
    maxAutoRetries === null ||
    maxEntries === null ||
    (maxAgeRaw !== '' && maxAge === null)
  ) {
    return {
      ok: false,
      error: 'DLQ values must be non-negative whole numbers; max entries must be at least 1.',
    };
  }
  return {
    ok: true,
    value: { autoRetry: config.autoRetry, autoRetryInterval, maxAutoRetries, maxAge, maxEntries },
  };
}

export type MutableDlqConfig = Pick<
  DlqConfig,
  'autoRetry' | 'autoRetryInterval' | 'maxAutoRetries'
>;

export function dlqConfigMutationPayload(config: DlqDraft): ConfigValidation<MutableDlqConfig> {
  const autoRetryInterval = toSafeWhole(config.autoRetryInterval, 0);
  const maxAutoRetries = toSafeWhole(config.maxAutoRetries, 0);
  if (autoRetryInterval === null || maxAutoRetries === null) {
    return {
      ok: false,
      error: 'Retry interval and max auto-retries must be non-negative whole numbers.',
    };
  }
  return {
    ok: true,
    value: { autoRetry: config.autoRetry, autoRetryInterval, maxAutoRetries },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export function isStallConfig(value: unknown): value is StallConfig {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    isFiniteNumber(value.stallInterval) &&
    isFiniteNumber(value.maxStalls) &&
    isFiniteNumber(value.gracePeriod)
  );
}

export function isDlqConfig(value: unknown): value is DlqConfig {
  return (
    isRecord(value) &&
    typeof value.autoRetry === 'boolean' &&
    isFiniteNumber(value.autoRetryInterval) &&
    isFiniteNumber(value.maxAutoRetries) &&
    (value.maxAge === null || isFiniteNumber(value.maxAge)) &&
    isFiniteNumber(value.maxEntries)
  );
}

export function assertConfigMutationResponse(value: unknown, endpoint: string): void {
  if (!isRecord(value) || value.ok !== true) {
    throw new Error(`Malformed ${endpoint} response: expected { ok: true }.`);
  }
}
