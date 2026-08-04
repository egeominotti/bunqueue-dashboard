import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';

import { ApiError, api, setRequestTimeoutMs as setApiTimeout } from '../src/lib/api';

import { BqError, bq, setRequestTimeoutMs as setBqTimeout } from '../src/lib/bq';

import { streamEvents } from '../src/lib/sse';

import { fetchHealthWithTimeout, isValidBaseUrl } from '../src/pages/Settings';

// Regression tests for the "net-clients" audit package: transport deadlines in
// both HTTP clients, the /storage strict-mode opt-out, the api.ts JSON parse
// guard, 401 credential correlation, and SSE body cleanup / idle liveness.

const realFetch = globalThis.fetch;

/** A server that accepts the connection and then never answers. */
function installHangingFetch() {
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // hangs forever — the pre-fix behaviour
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })) as typeof fetch;
}

export {
  ApiError,
  afterEach,
  api,
  BqError,
  beforeEach,
  bq,
  describe,
  expect,
  fetchHealthWithTimeout,
  installHangingFetch,
  isValidBaseUrl,
  realFetch,
  setApiTimeout,
  setBqTimeout,
  streamEvents,
  test,
  useConnectionStore,
};

export function installTestHooks() {
  beforeEach(() => {
    useConnectionStore.setState({ baseUrl: 'http://srv', token: '', agentToken: '' });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setBqTimeout(30_000);
    setApiTimeout(30_000);
    useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
  });
}
