import { describe, expect, test } from 'bun:test';
import {
  createE2EUpstreamEnvironment,
  E2E_HTTP_PORT,
  E2E_LOOPBACK_HOST,
  E2E_SERVER_TOKEN,
  E2E_TCP_PORT,
} from '../e2e/config';

describe('browser E2E network policy', () => {
  test('pins the disposable upstream to loopback despite inherited environment values', () => {
    const environment = createE2EUpstreamEnvironment('/tmp/browser-e2e.db', {
      AUTH_TOKENS: 'inherited-token',
      HOST: '0.0.0.0',
      HTTP_PORT: '80',
      TCP_PORT: '81',
    });

    expect(environment).toMatchObject({
      AUTH_TOKENS: E2E_SERVER_TOKEN,
      BUNQUEUE_DATA_PATH: '/tmp/browser-e2e.db',
      HOST: E2E_LOOPBACK_HOST,
      HTTP_PORT: String(E2E_HTTP_PORT),
      TCP_PORT: String(E2E_TCP_PORT),
    });
    expect(E2E_LOOPBACK_HOST).toBe('127.0.0.1');
  });
});
