import { beforeEach, describe, expect, test } from 'bun:test';
import {
  getAgentAuthHeaders,
  getAuthHeaders,
  persistedConnectionState,
  useConnectionStore,
} from '../src/components/dashboard/stores/connectionStore';

describe('connectionStore tokens', () => {
  beforeEach(() => {
    useConnectionStore.setState({ token: '', agentToken: '' });
  });

  // Security property: neither the server bearer token nor the agent token may
  // be written to localStorage — the persisted projection keeps only baseUrl +
  // refreshMs (same secrets-at-rest policy as the S3 keys).
  test('persisted projection excludes both tokens', () => {
    const persisted = persistedConnectionState({
      baseUrl: '/api',
      token: 'server-secret',
      agentToken: 'agent-secret',
      refreshMs: 3000,
      setBaseUrl: () => {},
      setToken: () => {},
      setAgentToken: () => {},
      setRefreshMs: () => {},
    });
    expect(persisted).toEqual({ baseUrl: '/api', refreshMs: 3000 });
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain('server-secret');
    expect(serialized).not.toContain('agent-secret');
  });

  test('getAgentAuthHeaders sends the agent token independently of the server token', () => {
    expect(getAgentAuthHeaders()).toEqual({});

    useConnectionStore.getState().setAgentToken('agent-tok');
    expect(getAgentAuthHeaders()).toEqual({ Authorization: 'Bearer agent-tok' });
    // The server-scoped headers must NOT pick up the agent token.
    expect(getAuthHeaders()).toEqual({});

    useConnectionStore.getState().setToken('server-tok');
    expect(getAuthHeaders()).toEqual({ Authorization: 'Bearer server-tok' });
    expect(getAgentAuthHeaders()).toEqual({ Authorization: 'Bearer agent-tok' });
  });
});
