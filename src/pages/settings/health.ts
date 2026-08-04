export const SETTINGS_TEST_TIMEOUT_MS = 10_000;

type HealthResponse = {
  ok: boolean;
  status: 'healthy' | 'degraded';
  uptime: number;
  version: string;
};

const BUNQUEUE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export async function fetchHealthWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = SETTINGS_TEST_TIMEOUT_MS
): Promise<{ response: Response; health: HealthResponse }> {
  const timeoutController = new AbortController();
  const callerSignal = init.signal;
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutController.signal])
    : timeoutController.signal;
  const timeoutError = new Error(
    `Connection test timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeCallerAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timeoutController.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  const callerCancellation = callerSignal
    ? new Promise<never>((_resolve, reject) => {
        const abort = () => {
          reject(callerSignal.reason ?? new DOMException('Connection test aborted', 'AbortError'));
        };
        if (callerSignal.aborted) abort();
        else {
          callerSignal.addEventListener('abort', abort, { once: true });
          removeCallerAbort = () => callerSignal.removeEventListener('abort', abort);
        }
      })
    : null;
  try {
    const request = (async () => {
      const response = await fetch(input, { ...init, signal });
      if (!response.ok && response.status !== 503) throw new Error(`HTTP ${response.status}`);
      const value = (await response.json()) as unknown;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Malformed health response');
      }
      const candidate = value as Record<string, unknown>;
      if (
        typeof candidate.ok !== 'boolean' ||
        (candidate.status !== 'healthy' && candidate.status !== 'degraded') ||
        !Number.isSafeInteger(candidate.uptime) ||
        (candidate.uptime as number) < 0 ||
        typeof candidate.version !== 'string' ||
        !BUNQUEUE_VERSION.test(candidate.version) ||
        candidate.ok !== (candidate.status === 'healthy')
      ) {
        throw new Error('Malformed health response');
      }
      return { response, health: candidate as HealthResponse };
    })();
    return await Promise.race(
      callerCancellation ? [request, deadline, callerCancellation] : [request, deadline]
    );
  } catch (error) {
    if (timeoutController.signal.aborted && timeoutController.signal.reason === timeoutError) {
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeCallerAbort?.();
  }
}
