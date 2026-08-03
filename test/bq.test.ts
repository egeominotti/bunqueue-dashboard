import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  DB_EXPORT_MAX_BYTES as AGENT_EXPORT_MAX_BYTES,
  DB_EXPORT_MAX_ROWS as AGENT_EXPORT_MAX_ROWS,
} from '../agent/db';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import {
  BqError,
  type BulkJobBody,
  bq,
  bulkJobPayloadBudgetError,
  DB_EXPORT_MAX_BYTES as CLIENT_EXPORT_MAX_BYTES,
  DB_EXPORT_MAX_ROWS as CLIENT_EXPORT_MAX_ROWS,
  captureServerRequestTarget,
  createServerTargetClient,
  getJobAtTarget,
  MAX_BULK_JOB_COUNT,
  resolveAgentBase,
  SAFE_AGENT_BASE,
} from '../src/lib/bq';

// Unit tests for the core API client's transport semantics (src/lib/bq.ts
// `call()`), exercised through the public `bq` surface with a mocked fetch:
// error mapping, the HTTP-200-{ok:false} convention and its health() opt-out,
// auth-header scoping (server vs agent), 401 → auth:required event scoping,
// and URL/body construction for representative endpoints.

interface Captured {
  url: string;
  init?: RequestInit;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

let calls: Captured[] = [];
let responder: (url: string, init?: RequestInit) => Response;
const realFetch = globalThis.fetch;

function lastCall(): Captured {
  const c = calls.at(-1);
  if (!c) throw new Error('no fetch captured');
  return c;
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  if (!init?.headers) return undefined;
  return new Headers(init.headers).get(name) ?? undefined;
}

beforeEach(() => {
  calls = [];
  responder = () => json({ ok: true });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(responder(String(input), init));
  }) as typeof fetch;
  useConnectionStore.setState({ baseUrl: 'http://srv', token: '', agentToken: '' });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  // Reset the shared singleton so a later test file can't inherit this file's
  // baseUrl/token mutations (bun test shares the module graph across files).
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
});

describe('bq transport (call)', () => {
  test('resolves the parsed body on a plain ok response', async () => {
    responder = () => json({ ok: true, uptime: 42 });
    const res = await bq.overview();
    expect((res as { uptime?: number }).uptime).toBe(42);
    expect(lastCall().url).toBe('http://srv/dashboard');
  });

  test('maps an HTTP error with a JSON error body to BqError(message, status)', async () => {
    responder = () => json({ ok: false, error: 'queue not found' }, 404);
    const err = await bq.counts('nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BqError);
    expect((err as BqError).message).toBe('queue not found');
    expect((err as BqError).status).toBe(404);
  });

  test('maps an HTTP error with a non-JSON body to "HTTP <status>"', async () => {
    responder = () => new Response('<html>gateway timeout</html>', { status: 504 });
    const err = await bq.stats().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BqError);
    expect((err as BqError).message).toBe('HTTP 504');
  });

  test('204 and empty 200 bodies resolve as undefined instead of a parse error', async () => {
    responder = () => new Response(null, { status: 204 });
    await expect(bq.cancelJob('j1')).resolves.toBeUndefined();
    responder = () => new Response('', { status: 200 });
    await expect(bq.pause('q')).resolves.toBeUndefined();
  });

  test('a 2xx with invalid JSON surfaces as BqError, not a raw SyntaxError', async () => {
    responder = () => new Response('not-json{', { status: 200 });
    const err = await bq.stats().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BqError);
    expect((err as BqError).message).toBe('Invalid JSON response (HTTP 200)');
  });

  test('HTTP 200 with {ok:false} throws (logical failure), defaulting the message', async () => {
    responder = () => json({ ok: false, error: 'job already finished' });
    await expect(bq.retryJob('j1')).rejects.toThrow('job already finished');
    responder = () => json({ ok: false });
    await expect(bq.retryJob('j1')).rejects.toThrow('Operation failed');
  });

  test('health() opts out of strict mode: ok:false is data, not an error', async () => {
    responder = () => json({ ok: false, status: 'degraded', version: '1.0.0' }, 503);
    const health = await bq.health();
    expect(health.ok).toBe(false);
    expect(health.version).toBe('1.0.0');
  });

  test('health() still rejects unrelated HTTP failures', async () => {
    responder = () => json({ ok: false, error: 'gateway down' }, 502);
    await expect(bq.health()).rejects.toThrow('gateway down');
  });
});

describe('bq auth scoping', () => {
  test('server token goes to server calls only; agent token to agent calls only', async () => {
    useConnectionStore.getState().setToken('srv-tok');
    useConnectionStore.getState().setAgentToken('agent-tok');

    await bq.stats();
    expect(headerOf(lastCall().init, 'Authorization')).toBe('Bearer srv-tok');

    await bq.control.status();
    const agentCall = lastCall();
    expect(agentCall.url).toBe('http://localhost:6800/control/status');
    expect(headerOf(agentCall.init, 'Authorization')).toBe('Bearer agent-tok');
  });

  test('a 401 dispatches auth:required scoped to the backend that rejected', async () => {
    // Swap in a bare EventTarget as `window`, restoring whatever was there
    // before (test files share one global scope — another file may have
    // installed a happy-dom window that must survive this test).
    const prev = (globalThis as { window?: unknown }).window;
    const target = new EventTarget();
    (globalThis as { window?: unknown }).window = target;
    try {
      const details: Array<{ scope: string; target: string }> = [];
      target.addEventListener('auth:required', (e) => {
        details.push((e as CustomEvent<{ scope: string; target: string }>).detail);
      });
      responder = () => json({ error: 'unauthorized' }, 401);
      await expect(bq.stats()).rejects.toThrow('unauthorized');
      await expect(bq.control.status()).rejects.toThrow('unauthorized');
      expect(details).toEqual([
        { scope: 'server', auth: undefined, target: 'http://srv' },
        { scope: 'agent', auth: undefined, target: bq.agentBase },
      ]);
    } finally {
      if (prev === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = prev;
      }
    }
  });

  test('agent base resolution rejects unsafe runtime/build values before bearer use', () => {
    expect(resolveAgentBase('/agent///', 'https://build.example/agent')).toBe('/agent');
    expect(resolveAgentBase('//runtime-attacker.example', 'https://build.example/agent/')).toBe(
      'https://build.example/agent'
    );
    for (const unsafe of [
      '//attacker.example',
      'https://user:secret@attacker.example',
      'https://attacker.example/agent?token=1',
      'https://attacker.example/agent#token',
      'file:///tmp/socket',
      42,
      { toString: () => '/agent' },
    ]) {
      expect(resolveAgentBase(unsafe, unsafe), String(unsafe)).toBe(SAFE_AGENT_BASE);
    }
  });

  test('agent transport uses its immutable validated snapshot after runtime-global mutation', async () => {
    const runtime = globalThis as { __BUNQUEUE_AGENT_URL__?: unknown };
    const previous = runtime.__BUNQUEUE_AGENT_URL__;
    const snapshot = bq.agentBase;
    try {
      runtime.__BUNQUEUE_AGENT_URL__ = '//attacker.example';
      useConnectionStore.getState().setAgentToken('agent-secret');
      await bq.control.status();
      expect(lastCall().url).toBe(`${snapshot}/control/status`);
      expect(lastCall().url).not.toContain('attacker.example');
      expect(headerOf(lastCall().init, 'Authorization')).toBe('Bearer agent-secret');
      expect(bq.agentBase).toBe(snapshot);
      const descriptor = Object.getOwnPropertyDescriptor(bq, 'agentBase');
      expect(descriptor?.set).toBeUndefined();
      expect(descriptor?.configurable).toBe(false);
    } finally {
      if (previous === undefined) delete runtime.__BUNQUEUE_AGENT_URL__;
      else runtime.__BUNQUEUE_AGENT_URL__ = previous;
    }
  });

  test('a hostile runtime present before fresh module init never receives the agent bearer', async () => {
    const runtime = globalThis as { __BUNQUEUE_AGENT_URL__?: unknown };
    const previous = runtime.__BUNQUEUE_AGENT_URL__;
    try {
      runtime.__BUNQUEUE_AGENT_URL__ = '//attacker.example';
      const isolated = await import('../src/lib/bq.ts?hostile-agent-runtime-before-init');
      expect(isolated.bq).not.toBe(bq);
      expect(isolated.bq.agentBase).not.toContain('attacker.example');

      useConnectionStore.getState().setAgentToken('pre-init-agent-secret');
      await isolated.bq.control.status();
      expect(lastCall().url).toBe(`${isolated.bq.agentBase}/control/status`);
      expect(lastCall().url).not.toContain('attacker.example');
      expect(headerOf(lastCall().init, 'Authorization')).toBe('Bearer pre-init-agent-secret');
    } finally {
      if (previous === undefined) delete runtime.__BUNQUEUE_AGENT_URL__;
      else runtime.__BUNQUEUE_AGENT_URL__ = previous;
    }
  });
});

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
    responder = () => json({ ok: true, job: { id: 'job-a' } });
    const result = await getJobAtTarget(target, 'job:a');
    expect(result.ok).toBe(true);
    expect(lastCall().url).toBe('/api/jobs/job:a');
    expect(headerOf(lastCall().init, 'Authorization')).toBe('Bearer token-a');

    const afterSafeLookup = calls.length;
    await expect(getJobAtTarget(target, 'job/a')).rejects.toThrow('path-safe IDs');
    expect(calls).toHaveLength(afterSafeLookup);

    const before = calls.length;
    await expect(getJobAtTarget({ baseUrl: 'https://attacker.example' }, 'job-a')).rejects.toThrow(
      'Invalid server request target'
    );
    expect(calls).toHaveLength(before);
  });

  test('job target cancellation stops both preflight and late signal-ignoring responses', async () => {
    useConnectionStore.setState({ baseUrl: 'https://server-a.example', token: 'token-a' });
    const target = captureServerRequestTarget();
    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new DOMException('walk stopped', 'AbortError'));
    await expect(getJobAtTarget(target, 'job-a', alreadyAborted.signal)).rejects.toThrow(
      'walk stopped'
    );
    expect(calls).toHaveLength(0);

    let resolveResponse: ((response: Response) => void) | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
    }) as typeof fetch;
    const lifecycle = new AbortController();
    const pending = getJobAtTarget(target, 'job-a', lifecycle.signal);
    lifecycle.abort(new DOMException('target changed', 'AbortError'));
    resolveResponse?.(json({ ok: true, job: { id: 'job-a' } }));
    await expect(pending).rejects.toThrow('target changed');
    expect(calls).toHaveLength(1);
  });

  test('a target client lifecycle abort also cancels its non-strict health request', async () => {
    useConnectionStore.setState({ baseUrl: 'https://server-a.example', token: 'token-a' });
    const lifecycle = new AbortController();
    const client = createServerTargetClient(captureServerRequestTarget(), lifecycle.signal);
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
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
    expect(calls).toHaveLength(1);
    expect(requestSignal?.aborted).toBe(true);
  });
});

describe('bq request construction', () => {
  test('queue paths encode valid punctuation and reject unmanageable names before fetch', async () => {
    await bq.dlq('orders:eu.1');
    expect(lastCall().url).toBe('http://srv/queues/orders%3Aeu.1/dlq?limit=100&offset=0');

    const callsBeforeInvalid = calls.length;
    expect(() => bq.dlq('my/queue #1')).toThrow('Queue names may contain only');
    expect(() => bq.dlq('.')).toThrow('path traversal segment');
    expect(() => bq.dlq('..')).toThrow('path traversal segment');
    expect(calls).toHaveLength(callsBeforeInvalid);
  });

  test('jobsList builds states/limit/offset query params', async () => {
    responder = () => json({ ok: true, jobs: [] });
    await bq.jobsList('q1', ['waiting', 'active'], 25, 50);
    expect(lastCall().url).toBe(
      'http://srv/queues/q1/jobs/list?states=waiting%2Cactive&limit=25&offset=50'
    );
  });

  test('rate-limit and concurrency send the server-verified body shapes', async () => {
    await bq.setRateLimit('q1', 100);
    expect(lastCall().init?.method).toBe('PUT');
    expect(lastCall().init?.body).toBe(JSON.stringify({ limit: 100 }));

    await bq.setRateLimit('q1', 100, 60_000, 3_600_000);
    expect(lastCall().init?.body).toBe(
      JSON.stringify({ limit: 100, duration: 60_000, ttl: 3_600_000 })
    );

    await bq.setConcurrency('q1', 4);
    expect(lastCall().init?.body).toBe(JSON.stringify({ concurrency: 4 }));
  });

  test('v2.8.55 job-management options are preserved', async () => {
    await bq.changePriority('j1', 7, true);
    expect(lastCall().init?.body).toBe(JSON.stringify({ priority: 7, lifo: true }));

    await bq.failJob('j1', 'fatal', {
      unrecoverable: true,
      stack: ['worker.ts:12'],
    });
    expect(lastCall().init?.body).toBe(
      JSON.stringify({ error: 'fatal', unrecoverable: true, stack: ['worker.ts:12'] })
    );
  });

  test('v2.8.55 cron options are preserved', async () => {
    await bq.createCron({
      name: 'nightly',
      queue: 'reports',
      schedule: '0 2 * * *',
      dedup: { ttl: 60_000, extend: true, replace: false },
      jobOptions: {
        delay: 500,
        stallTimeout: 30_000,
        removeOnComplete: true,
        removeOnFail: false,
      },
    });

    expect(lastCall().init?.body).toBe(
      JSON.stringify({
        name: 'nightly',
        queue: 'reports',
        schedule: '0 2 * * *',
        dedup: { ttl: 60_000, extend: true, replace: false },
        jobOptions: {
          delay: 500,
          stallTimeout: 30_000,
          removeOnComplete: true,
          removeOnFail: false,
        },
      })
    );
  });

  test('DLQ retry and completed requeue fail synchronously before transport', () => {
    const before = calls.length;
    expect(() => bq.retryDlq('q1')).toThrow(/unavailable|disabled|flow/i);
    expect(() => bq.retryDlq('q1', 'job-9')).toThrow(/unavailable|disabled|flow/i);
    expect(() => bq.retryCompleted('q1')).toThrow(/unavailable|disabled|flow/i);
    expect(() => bq.retryCompleted('q1', 'job-9')).toThrow(/unavailable|disabled|flow/i);
    expect(calls).toHaveLength(before);
  });

  test('rejects enabling DLQ auto-retry before transport', () => {
    const before = calls.length;
    expect(() => bq.setDlqConfig('orders', { autoRetry: true })).toThrow(
      'DLQ auto-retry is unavailable'
    );
    expect(calls).toHaveLength(before);
  });

  test('rejects unsupported DLQ retention patches before transport', () => {
    const before = calls.length;
    expect(() => bq.setDlqConfig('orders', { maxAge: null })).toThrow(
      /retention|maxAge|unavailable/i
    );
    expect(() => bq.setDlqConfig('orders', { maxEntries: 10_000 })).toThrow(
      /retention|maxEntries|unavailable/i
    );
    expect(() => bq.setDlqConfig('orders', { maxAge: 60_000, maxEntries: 100 })).toThrow(
      /retention|maxAge|maxEntries|unavailable/i
    );
    expect(calls).toHaveLength(before);
  });

  test('bulk jobs translate the public jobId field to the upstream customId field', async () => {
    responder = () => json({ ok: true, ids: ['custom-1'] });
    await bq.addJobsBulk('q1', [{ data: { x: 1 }, jobId: 'custom-1', tags: ['audit'] }]);
    expect(lastCall().init?.body).toBe(
      JSON.stringify({ jobs: [{ data: { x: 1 }, tags: ['audit'], customId: 'custom-1' }] })
    );
  });

  test('bulk payload budget matches the exact translated UTF-8 envelope boundary', () => {
    const jobs = [
      { data: { emoji: '💥' }, jobId: 'stable-id' },
      { data: 'é', priority: 2 },
    ];
    const translated = jobs.map(({ jobId, ...job }) =>
      jobId === undefined ? job : { ...job, customId: jobId }
    );
    const exactBytes = new TextEncoder().encode(JSON.stringify({ jobs: translated })).byteLength;
    expect(bulkJobPayloadBudgetError(jobs, exactBytes)).toBeNull();
    expect(bulkJobPayloadBudgetError(jobs, exactBytes - 1)).toContain('payload exceeds');
  });

  test('sends the same bounded toJSON serialization measured by the core request pass', async () => {
    let serializations = 0;
    const job = {
      data: {
        toJSON: () => ({ pass: ++serializations }),
      },
    };

    // Simulate AddJob/BulkAddJobs' allocation-light UI preflight. The core
    // pass may observe a different value, but it must send exactly that second
    // representation without invoking toJSON a third time.
    expect(bulkJobPayloadBudgetError([job], 1024)).toBeNull();
    responder = () => json({ ok: true, ids: ['j1'] });
    await bq.addJobsBulk('q1', [job]);

    expect(serializations).toBe(2);
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({
      jobs: [{ data: { pass: 2 } }],
    });
  });

  test('reads a mutable bulk-job getter once and sends the captured value', async () => {
    let getterReads = 0;
    const job = Object.defineProperty({}, 'data', {
      enumerable: true,
      get: () => ({ read: ++getterReads }),
    }) as import('../src/lib/bq').BulkJobBody;

    responder = () => json({ ok: true, ids: ['j1'] });
    await bq.addJobsBulk('q1', [job]);

    expect(getterReads).toBe(1);
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({
      jobs: [{ data: { read: 1 } }],
    });
  });

  test('captures guarded getters once, then validates and sends that same representation', async () => {
    const reads = { parentId: 0, repeat: 0, jobId: 0, dependsOn: 0 };
    const job = Object.defineProperties(
      { data: { ok: true } },
      {
        parentId: {
          enumerable: true,
          get: () => (++reads.parentId === 1 ? undefined : 'victim-parent'),
        },
        repeat: {
          enumerable: true,
          get: () => (++reads.repeat === 1 ? { every: 1000 } : { pattern: '* * * * *' }),
        },
        jobId: {
          enumerable: true,
          get: () => (++reads.jobId === 1 ? 'safe-id' : '..'),
        },
        dependsOn: {
          enumerable: true,
          get: () => (++reads.dependsOn === 1 ? ['dep-safe'] : ['..']),
        },
      }
    ) as BulkJobBody;

    responder = () => json({ ok: true, ids: ['safe-id'] });
    await bq.addJobsBulk('q1', [job]);

    expect(reads).toEqual({ parentId: 1, repeat: 1, jobId: 1, dependsOn: 1 });
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({
      jobs: [
        {
          data: { ok: true },
          repeat: { every: 1000 },
          dependsOn: ['dep-safe'],
          customId: 'safe-id',
        },
      ],
    });
  });

  test('both bulk clients reject forbidden fields injected by the exact JSON representation', async () => {
    const targetClient = createServerTargetClient(captureServerRequestTarget());
    const forbidden: Array<Record<string, unknown>> = [
      { parentId: 'victim-parent' },
      { continueParentOnFailure: true },
      { repeat: { pattern: '* * * * *' } },
      { jobId: 'wrong-domain-spelling' },
      { dependsOn: ['..'] },
    ];
    const clients = [
      (jobs: BulkJobBody[]) => bq.addJobsBulk('q1', jobs),
      (jobs: BulkJobBody[]) => targetClient.addJobsBulk('q1', jobs),
    ];

    for (const invoke of clients) {
      for (const injected of forbidden) {
        const before = calls.length;
        const job = {
          data: {},
          toJSON: () => ({ data: { exact: true }, ...injected }),
        } as unknown as BulkJobBody;
        await expect(invoke([job])).rejects.toThrow();
        expect(calls).toHaveLength(before);
      }
    }
  });

  test('serializes every repeated reference occurrence once without a size-cache mismatch', async () => {
    let serializations = 0;
    const job = {
      data: {
        toJSON: () => ({ occurrence: ++serializations }),
      },
    };

    responder = () => json({ ok: true, ids: ['j1', 'j2'] });
    await bq.addJobsBulk('q1', [job, job]);

    expect(serializations).toBe(2);
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({
      jobs: [{ data: { occurrence: 1 } }, { data: { occurrence: 2 } }],
    });
  });

  test('target-client bulk enqueue also sends its single measured serialization pass', async () => {
    let serializations = 0;
    const client = createServerTargetClient(captureServerRequestTarget());
    const job = {
      data: {
        toJSON: () => ({ pass: ++serializations }),
      },
    };

    responder = () => json({ ok: true, ids: ['j1'] });
    await client.addJobsBulk('q1', [job]);

    expect(serializations).toBe(1);
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({
      jobs: [{ data: { pass: 1 } }],
    });
  });

  test('rejects a valid per-job data x count envelope before aggregate JSON allocation', async () => {
    // This body is below Bunqueue's 10 MiB per-job data limit. Repeating the
    // same object 10k times would otherwise ask JSON.stringify for ~97.7 GiB.
    const body = { data: { blob: 'x'.repeat(10 * 1024 * 1024 - 64) } };
    const jobs = Array.from({ length: 10_000 }, () => body);
    expect(bulkJobPayloadBudgetError(jobs)).toContain('64 MiB');

    const before = calls.length;
    await expect(bq.addJobsBulk('q1', jobs)).rejects.toThrow('64 MiB');
    expect(calls).toHaveLength(before);
  });

  test('rejects oversized bulk collections before validation or fragment allocation', async () => {
    const job = { data: {} };
    const jobs = Array.from({ length: MAX_BULK_JOB_COUNT + 1 }, () => job);
    const before = calls.length;
    expect(bulkJobPayloadBudgetError(jobs)).toContain(`at most ${MAX_BULK_JOB_COUNT}`);
    await expect(bq.addJobsBulk('q1', jobs)).rejects.toThrow(`at most ${MAX_BULK_JOB_COUNT}`);
    expect(calls).toHaveLength(before);
  });

  test('unsafe repeat shapes are rejected locally before any enqueue request', async () => {
    const before = calls.length;
    await expect(
      bq.addJob('q1', {
        data: {},
        repeat: { pattern: '* * * * *' } as unknown as { every: number },
      })
    ).rejects.toThrow('pattern repeats are unsafe');
    await expect(
      bq.addJobsBulk('q1', [
        { data: {}, repeat: { every: 0 } },
        { data: {}, repeat: { every: 1000 } },
      ])
    ).rejects.toThrow('Repeat "every"');
    expect(calls).toHaveLength(before);
  });

  test('single add captures guarded getters once, validates, and sends that exact body', async () => {
    const reads = { parentId: 0, repeat: 0, jobId: 0, dependsOn: 0 };
    const job = Object.defineProperties(
      { data: { exact: true } },
      {
        parentId: {
          enumerable: true,
          get: () => (++reads.parentId === 1 ? undefined : 'victim-parent'),
        },
        repeat: {
          enumerable: true,
          get: () => (++reads.repeat === 1 ? { every: 1000 } : { pattern: '* * * * *' }),
        },
        jobId: {
          enumerable: true,
          get: () => (++reads.jobId === 1 ? 'safe-id' : '..'),
        },
        dependsOn: {
          enumerable: true,
          get: () => (++reads.dependsOn === 1 ? ['safe-dep'] : ['..']),
        },
      }
    ) as import('../src/lib/bq').AddJobBody;

    responder = () => json({ ok: true, id: 'safe-id' });
    await bq.addJob('q1', job);

    expect(reads).toEqual({ parentId: 1, repeat: 1, jobId: 1, dependsOn: 1 });
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({
      data: { exact: true },
      repeat: { every: 1000 },
      jobId: 'safe-id',
      dependsOn: ['safe-dep'],
    });
  });

  test('single add rejects forbidden fields injected by its exact root toJSON value', async () => {
    const forbidden: unknown[] = [
      { data: {}, parentId: 'victim-parent' },
      { data: {}, continueParentOnFailure: true },
      { data: {}, repeat: { pattern: '* * * * *' } },
      { data: {}, jobId: '..' },
      { data: {}, dependsOn: ['..'] },
      { data: {}, dependsOn: 'not-an-array' },
      ['not', 'a', 'job'],
      null,
    ];

    for (const exact of forbidden) {
      let serializations = 0;
      const before = calls.length;
      const job = {
        data: {},
        toJSON: () => {
          serializations += 1;
          return exact;
        },
      } as unknown as import('../src/lib/bq').AddJobBody;
      await expect(bq.addJob('q1', job)).rejects.toThrow();
      expect(serializations).toBe(1);
      expect(calls).toHaveLength(before);
    }
  });

  test('unsafe bulk topology and inert compatibility fields never reach PUSHB', async () => {
    const before = calls.length;
    await expect(
      bq.addJobsBulk('q1', [
        {
          data: {},
          parentId: 'victim',
          failParentOnFailure: true,
        } as unknown as import('../src/lib/bq').BulkJobBody,
      ])
    ).rejects.toThrow('Flow topology must use the atomic flow API');
    expect(calls).toHaveLength(before);
  });

  test('safe interval repeats are sent unchanged', async () => {
    responder = () => json({ ok: true, id: 'repeat-1' });
    await bq.addJob('q1', { data: {}, repeat: { every: 60_000, limit: 3 } });
    expect(lastCall().init?.body).toBe(
      JSON.stringify({ data: {}, repeat: { every: 60_000, limit: 3 } })
    );
  });

  test('db.rows composes paging, ordering and filter params for the agent', async () => {
    responder = () => json({ ok: true, rows: [] });
    await bq.db.rows('jobs', 50, 100, 'id', 'desc', {
      column: 'state',
      op: 'eq',
      value: 'failed',
    });
    expect(lastCall().url).toBe(
      'http://localhost:6800/db/tables/jobs?limit=50&offset=100&orderBy=id&dir=desc&fcol=state&fop=eq&fval=failed'
    );
  });

  test('database CSV export uses one target-pinned request and validates raw metadata', async () => {
    expect(CLIENT_EXPORT_MAX_ROWS).toBe(AGENT_EXPORT_MAX_ROWS);
    expect(CLIENT_EXPORT_MAX_BYTES).toBe(AGENT_EXPORT_MAX_BYTES);
    useConnectionStore.getState().setAgentToken('export-token');
    const csv = new TextEncoder().encode('id\r\n1');
    responder = () =>
      new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Length': String(csv.byteLength),
          'X-Bunqueue-Db-Export-Version': '1',
          'X-Bunqueue-Db-Export-Table': encodeURIComponent('job rows'),
          'X-Bunqueue-Db-Export-Rows': '1',
          'X-Bunqueue-Db-Export-Bytes': String(csv.byteLength),
          'X-Bunqueue-Db-Export-Cap': 'none',
        },
      });

    const exported = await bq.getDbExportAtTarget(bq.captureAgentRequestTarget(), {
      table: 'job rows',
      orderBy: 'id',
      dir: 'desc',
      filter: { column: 'state', op: 'eq', value: 'failed' },
    });
    expect(lastCall().url).toBe(
      'http://localhost:6800/db/tables/job%20rows/export?orderBy=id&dir=desc&fcol=state&fop=eq&fval=failed'
    );
    expect(headerOf(lastCall().init, 'Authorization')).toBe('Bearer export-token');
    expect(exported).toMatchObject({
      table: 'job rows',
      rowCount: 1,
      bytes: csv.byteLength,
      cap: null,
    });
    expect(new TextDecoder().decode(exported.content)).toBe('id\r\n1');
  });

  test('database CSV export rejects a mismatched table or contradictory length metadata', async () => {
    const response = (table: string, bytes: string, contentLength = '5') =>
      new Response('id\r\n1', {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Length': contentLength,
          'X-Bunqueue-Db-Export-Version': '1',
          'X-Bunqueue-Db-Export-Table': encodeURIComponent(table),
          'X-Bunqueue-Db-Export-Rows': '1',
          'X-Bunqueue-Db-Export-Bytes': bytes,
          'X-Bunqueue-Db-Export-Cap': 'none',
        },
      });
    responder = () => response('other', '5');
    await expect(
      bq.getDbExportAtTarget(bq.captureAgentRequestTarget(), { table: 'jobs', dir: 'asc' })
    ).rejects.toThrow('requested "jobs", received "other"');

    responder = () => response('jobs', '4');
    await expect(
      bq.getDbExportAtTarget(bq.captureAgentRequestTarget(), { table: 'jobs', dir: 'asc' })
    ).rejects.toThrow('Content-Length does not match');

    responder = () => response('jobs', '4', '4');
    await expect(
      bq.getDbExportAtTarget(bq.captureAgentRequestTarget(), { table: 'jobs', dir: 'asc' })
    ).rejects.toThrow('body exceeds declared 4 bytes');

    responder = () => response('jobs', '5', 'not-a-number');
    await expect(
      bq.getDbExportAtTarget(bq.captureAgentRequestTarget(), { table: 'jobs', dir: 'asc' })
    ).rejects.toThrow('invalid Content-Length header');

    responder = () => response('jobs', '5', String(CLIENT_EXPORT_MAX_BYTES + 1));
    await expect(
      bq.getDbExportAtTarget(bq.captureAgentRequestTarget(), { table: 'jobs', dir: 'asc' })
    ).rejects.toThrow('invalid Content-Length header');
  });

  test('db.cell preserves and encodes an exact 64-bit rowid', async () => {
    await bq.db.cell('job rows', '9007199254740993', 'payload/value');
    expect(lastCall().url).toBe(
      'http://localhost:6800/db/tables/job%20rows/cell?rowid=9007199254740993&column=payload%2Fvalue'
    );
  });

  test('uses each upstream route decoding contract and rejects dot retargeting locally', async () => {
    await bq.jobByCustomId('order /:%');
    expect(lastCall().url).toBe('http://srv/jobs/custom/order%20%2F%3A%25');

    await bq.deleteCron('nightly /:%');
    expect(lastCall().url).toBe('http://srv/crons/nightly%20%2F%3A%25');

    await bq.removeWebhook('hook:@+');
    expect(lastCall().url).toBe('http://srv/webhooks/hook:@+');

    const before = calls.length;
    expect(() => bq.jobByCustomId('.')).toThrow('path traversal segment');
    expect(() => bq.deleteCron('..')).toThrow('path traversal segment');
    expect(() => bq.db.schema('.')).toThrow('path traversal segment');
    expect(() => bq.removeWebhook('..')).toThrow('path traversal segment');
    await expect(bq.getDbRowsAtTarget(bq.captureAgentRequestTarget(), '.', 50, 0)).rejects.toThrow(
      'path traversal segment'
    );
    expect(calls).toHaveLength(before);
  });

  test('eventsUrl tracks the live baseUrl and preserves the raw v2.8.55 queue suffix', () => {
    expect(bq.eventsUrl()).toBe('http://srv/events');
    expect(bq.eventsUrl('foo:bar')).toBe('http://srv/events/queues/foo:bar');
    expect(() => bq.eventsUrl('a/b')).toThrow('Invalid Bunqueue queue name');
    useConnectionStore.getState().setBaseUrl('http://other/');
    expect(bq.eventsUrl()).toBe('http://other/events');
  });
});
