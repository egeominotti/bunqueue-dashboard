import {
  BqError,
  bq,
  describe,
  expect,
  fetchHarness,
  installTestHooks,
  json,
  lastCall,
  test,
} from './bq.helpers';

installTestHooks();

describe('bq transport (call)', () => {
  test('resolves the parsed body on a plain ok response', async () => {
    fetchHarness.responder = () => json({ ok: true, uptime: 42 });
    const res = await bq.overview();
    expect((res as { uptime?: number }).uptime).toBe(42);
    expect(lastCall().url).toBe('http://srv/dashboard');
  });

  test('maps an HTTP error with a JSON error body to BqError(message, status)', async () => {
    fetchHarness.responder = () => json({ ok: false, error: 'queue not found' }, 404);
    const err = await bq.counts('nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BqError);
    expect((err as BqError).message).toBe('queue not found');
    expect((err as BqError).status).toBe(404);
  });

  test('maps an HTTP error with a non-JSON body to "HTTP <status>"', async () => {
    fetchHarness.responder = () => new Response('<html>gateway timeout</html>', { status: 504 });
    const err = await bq.stats().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BqError);
    expect((err as BqError).message).toBe('HTTP 504');
  });

  test('204 and empty 200 bodies resolve as undefined instead of a parse error', async () => {
    fetchHarness.responder = () => new Response(null, { status: 204 });
    await expect(bq.cancelJob('j1')).resolves.toBeUndefined();
    fetchHarness.responder = () => new Response('', { status: 200 });
    await expect(bq.pause('q')).resolves.toBeUndefined();
  });

  test('a 2xx with invalid JSON surfaces as BqError, not a raw SyntaxError', async () => {
    fetchHarness.responder = () => new Response('not-json{', { status: 200 });
    const err = await bq.stats().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BqError);
    expect((err as BqError).message).toBe('Invalid JSON response (HTTP 200)');
  });

  test('HTTP 200 with {ok:false} throws (logical failure), defaulting the message', async () => {
    fetchHarness.responder = () => json({ ok: false, error: 'job already finished' });
    await expect(bq.retryJob('j1')).rejects.toThrow('job already finished');
    fetchHarness.responder = () => json({ ok: false });
    await expect(bq.retryJob('j1')).rejects.toThrow('Operation failed');
  });

  test('health() opts out of strict mode: ok:false is data, not an error', async () => {
    fetchHarness.responder = () => json({ ok: false, status: 'degraded', version: '1.0.0' }, 503);
    const health = await bq.health();
    expect(health.ok).toBe(false);
    expect(health.version).toBe('1.0.0');
  });

  test('health() still rejects unrelated HTTP failures', async () => {
    fetchHarness.responder = () => json({ ok: false, error: 'gateway down' }, 502);
    await expect(bq.health()).rejects.toThrow('gateway down');
  });
});
