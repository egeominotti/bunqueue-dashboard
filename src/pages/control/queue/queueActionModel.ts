export type RunAction = (
  label: string,
  fn: () => Promise<unknown>,
  confirmMsg?: string,
  onSuccess?: () => void
) => void;

export function cleanArgs(
  graceRaw: string,
  limitRaw: string
): { grace: number; limit: number; valid: boolean } {
  const grace = Number(graceRaw);
  const limit = Number(limitRaw);
  const valid =
    graceRaw.trim() !== '' &&
    limitRaw.trim() !== '' &&
    Number.isSafeInteger(grace) &&
    Number.isSafeInteger(limit) &&
    grace >= 0 &&
    limit > 0;
  return { grace, limit, valid };
}

export function promoteCountArgs(raw: string): { count?: number; valid: boolean } {
  if (!raw.trim()) return { valid: true };
  const count = Number(raw);
  return Number.isSafeInteger(count) && count > 0 ? { count, valid: true } : { valid: false };
}

export function promoteConfirmation(queue: string, count?: number): string {
  return count === undefined
    ? `Promote every delayed job in "${queue}" and make it eligible to run now?`
    : `Promote up to ${count} delayed jobs in "${queue}" and make them eligible to run now?`;
}

export function rateLimitArgs(
  limitRaw: string,
  durationRaw: string,
  ttlRaw: string
): { limit: number; duration: number; ttl?: number; valid: boolean } {
  const parseOptional = (raw: string): number | undefined | null => {
    if (!raw.trim()) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  const limit = parseOptional(limitRaw);
  const duration = parseOptional(durationRaw);
  const ttl = parseOptional(ttlRaw);
  return {
    limit: typeof limit === 'number' ? limit : 0,
    duration: typeof duration === 'number' ? duration : 0,
    ...(typeof ttl === 'number' ? { ttl } : {}),
    valid: typeof limit === 'number' && typeof duration === 'number' && ttl !== null,
  };
}

export function concurrencyArgs(raw: string): { value: number; valid: boolean } {
  const value = Number(raw);
  return {
    value,
    valid: raw.trim() !== '' && Number.isSafeInteger(value) && value > 0,
  };
}

export type CleanState = 'completed' | 'failed' | 'waiting';

export function cleanStateDescription(state: CleanState): string {
  if (state === 'completed') return 'completed jobs';
  if (state === 'failed') return 'failed jobs and their DLQ entries';
  return 'queued jobs (waiting, delayed, and prioritized)';
}
