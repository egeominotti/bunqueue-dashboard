import { expect, test } from 'bun:test';
import { managedConnection } from '../agent/managedConnection';
import type { ServerConfig } from '../agent/manager';
import { workflowRuntimeSignature } from '../agent/workflow/runtimeConfig';

const config = (extraEnv: Record<string, string> = {}): ServerConfig => ({
  command: 'unused',
  httpPort: 6790,
  tcpPort: 6789,
  dataPath: '/unused',
  extraEnv: {
    TLS_CERT_FILE: '',
    TLS_KEY_FILE: '',
    BUNQUEUE_AGENT_TCP_TLS: '',
    BUNQUEUE_AGENT_TCP_CA_FILE: '',
    AUTH_TOKENS: 'first,second',
    ...extraEnv,
  },
});

test('plain TCP remains local and authenticated; TLS never disables verification', () => {
  expect(managedConnection(config())).toEqual({ host: '127.0.0.1', port: 6789, token: 'first' });
  expect(managedConnection(config({ BUNQUEUE_AGENT_TCP_TLS: 'true' })).tls).toEqual({
    rejectUnauthorized: true,
  });
  expect(managedConnection(config({ TLS_CERT_FILE: '/server.pem' })).tls).toEqual({
    rejectUnauthorized: true,
  });
});

test('invalid TLS settings fail closed instead of silently using plain TCP', () => {
  for (const extra of [
    { BUNQUEUE_AGENT_TCP_TLS: 'yes' },
    { BUNQUEUE_AGENT_TCP_TLS: 'false', TLS_KEY_FILE: '/server.key' },
    { BUNQUEUE_AGENT_TCP_CA_FILE: 'relative.pem' },
    { BUNQUEUE_AGENT_TCP_CA_FILE: '/nonexistent/bunqueue-ca.pem' },
  ])
    expect(() => managedConnection(config(extra))).toThrow();
});

test('TLS configuration changes invalidate the persistent workflow connection', () => {
  const opts = { queueName: 'wf', concurrency: 1 };
  const before = workflowRuntimeSignature(config(), '/module.ts', 1, opts);
  const after = workflowRuntimeSignature(
    config({ BUNQUEUE_AGENT_TCP_TLS: 'true' }),
    '/module.ts',
    1,
    opts
  );
  expect(after).not.toBe(before);
});
