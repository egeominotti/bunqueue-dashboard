import {
  bq,
  captureServerRequestTarget,
  createServerTargetClient,
  describe,
  expect,
  fetchHarness,
  getJobAtTarget,
  headerOf,
  installTestHooks,
  json,
  lastCall,
  test,
  useConnectionStore,
} from './bq.helpers';

installTestHooks();

describe('immutable server request targets', () => {
  test('a captured job request keeps one sanitized origin and matching bearer token', async () => {
    useConnectionStore.setState({ baseUrl: '//legacy.example', token: 'token-a' });
    const target = captureServerRequestTarget();
    expect(target.baseUrl).toBe('/api');
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.keys(target)).toEqual(['baseUrl']);
    expect(bq.captureServerRequestTarget).toBe(captureServerRequestTarget);
    expect(bq.getJobAtTarget).toBe(getJobAtTarget);

    useConnectionStore.setState({ baseUrl: 'https://server-b.example', token: 'token-b' });
    fetchHarness.responder = () => json({ ok: true, job: { id: 'job-a' } });
    const result = await getJobAtTarget(target, 'job:a');
    expect(result.ok).toBe(true);
    expect(lastCall().url).toBe('/api/jobs/job:a');
    expect(headerOf(lastCall().init, 'Authorization')).toBe('Bearer token-a');

    const afterSafeLookup = fetchHarness.calls.length;
    await expect(getJobAtTarget(target, 'job/a')).rejects.toThrow('path-safe IDs');
    expect(fetchHarness.calls).toHaveLength(afterSafeLookup);

    const before = fetchHarness.calls.length;
    await expect(getJobAtTarget({ baseUrl: 'https://attacker.example' }, 'job-a')).rejects.toThrow(
      'Invalid server request target'
    );
    expect(fetchHarness.calls).toHaveLength(before);
  });

  test('job target cancellation stops both preflight and late signal-ignoring responses', async () => {
    useConnectionStore.setState({ baseUrl: 'https://server-a.example', token: 'token-a' });
    const target = captureServerRequestTarget();
    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new DOMException('walk stopped', 'AbortError'));
    await expect(getJobAtTarget(target, 'job-a', alreadyAborted.signal)).rejects.toThrow(
      'walk stopped'
    );
    expect(fetchHarness.calls).toHaveLength(0);

    let resolveResponse: ((response: Response) => void) | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      fetchHarness.calls.push({ url: String(input), init });
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
    }) as typeof fetch;
    const lifecycle = new AbortController();
    const pending = getJobAtTarget(target, 'job-a', lifecycle.signal);
    lifecycle.abort(new DOMException('target changed', 'AbortError'));
    resolveResponse?.(json({ ok: true, job: { id: 'job-a' } }));
    await expect(pending).rejects.toThrow('target changed');
    expect(fetchHarness.calls).toHaveLength(1);
  });

  test('a target client lifecycle abort also cancels its non-strict health request', async () => {
    useConnectionStore.setState({ baseUrl: 'https://server-a.example', token: 'token-a' });
    const lifecycle = new AbortController();
    const client = createServerTargetClient(captureServerRequestTarget(), lifecycle.signal);
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      fetchHarness.calls.push({ url: String(input), init });
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () =>
          reject(requestSignal?.reason ?? new DOMException('Aborted', 'AbortError'));
        if (requestSignal?.aborted) abort();
        else requestSignal?.addEventListener('abort', abort, { once: true });
      });
    }) as typeof fetch;

    const pending = client.health();
    lifecycle.abort(new DOMException('turn stopped', 'AbortError'));
    await expect(pending).rejects.toThrow('turn stopped');
    expect(fetchHarness.calls).toHaveLength(1);
    expect(requestSignal?.aborted).toBe(true);
  });
});
