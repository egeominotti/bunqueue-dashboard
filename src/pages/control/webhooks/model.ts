import type { AddWebhookBody } from '@/lib/bq';

export function isDeliverableUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      value.length <= 2_048 &&
      /^https?:$/.test(parsed.protocol) &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

export function displayWebhookUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (!parsed.username && !parsed.password) return value;
    parsed.username = 'redacted';
    parsed.password = 'redacted';
    return parsed.toString();
  } catch {
    return value;
  }
}

export function buildWebhookBody(
  url: string,
  events: string[],
  queue: string,
  secret: string
): { ok: true; body: AddWebhookBody } | { ok: false; msg: string } {
  const normalizedUrl = url.trim();
  if (!normalizedUrl || events.length === 0) {
    return { ok: false, msg: 'URL and at least one event are required' };
  }
  if (!isDeliverableUrl(normalizedUrl)) {
    return {
      ok: false,
      msg: 'URL must be a valid http:// or https:// address without embedded credentials',
    };
  }
  const normalizedQueue = queue.trim();
  if (
    normalizedQueue &&
    (normalizedQueue.length > 256 || !/^[a-zA-Z0-9_\-.:]+$/.test(normalizedQueue))
  ) {
    return {
      ok: false,
      msg: 'Queue must be at most 256 characters using letters, numbers, _, -, . or :',
    };
  }
  return {
    ok: true,
    body: {
      url: normalizedUrl,
      events,
      queue: normalizedQueue || undefined,
      secret: secret.trim() || undefined,
    },
  };
}
