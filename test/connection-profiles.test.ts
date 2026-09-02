import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  captureConnectionProfileTarget,
  CONNECTION_STORAGE_KEY,
  persistedConnectionState,
  sanitizedPersistedConnectionState,
  useConnectionStore,
} from '../src/components/dashboard/stores/connectionStore';
import { bq } from '../src/lib/bq';

const realFetch = globalThis.fetch;
const local = {
  id: 'default',
  name: 'Local Bunqueue',
  baseUrl: '/api',
  agentBaseUrl: 'http://localhost:6800',
};

function reset() {
  useConnectionStore.setState({
    profiles: [local],
    activeProfileId: local.id,
    baseUrl: local.baseUrl,
    agentBaseUrl: local.agentBaseUrl,
    token: '',
    agentToken: '',
    refreshMs: 3000,
  });
  useConnectionStore.getState().setToken('');
  useConnectionStore.getState().setAgentToken('');
  localStorage.removeItem(CONNECTION_STORAGE_KEY);
}

beforeEach(reset);
afterEach(() => {
  globalThis.fetch = realFetch;
  reset();
});

describe('multi-node connection profiles', () => {
  test('switches server and agent targets atomically while isolating both credentials', async () => {
    useConnectionStore.getState().saveConnection({
      name: 'Broker A',
      baseUrl: 'https://a.example/api',
      agentBaseUrl: 'https://a.example/agent',
      token: 'server-a',
      agentToken: 'agent-a',
    });
    const added = useConnectionStore.getState().addProfile({
      name: 'Broker B',
      baseUrl: 'https://b.example/api/',
      agentBaseUrl: 'https://b.example/agent/',
      token: 'server-b',
      agentToken: 'agent-b',
    });
    expect(added.id).toBeString();
    const requests: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        auth: new Headers(init?.headers).get('Authorization'),
      });
      return Promise.resolve(Response.json({ ok: true, status: 'stopped', config: {} }));
    }) as typeof fetch;

    await bq.stats();
    await bq.control.status();
    expect(requests).toEqual([
      { url: 'https://b.example/api/stats', auth: 'Bearer server-b' },
      { url: 'https://b.example/agent/control/status', auth: 'Bearer agent-b' },
    ]);

    expect(useConnectionStore.getState().activateProfile('default')).toBe(true);
    await bq.stats();
    await bq.control.status();
    expect(requests.slice(2)).toEqual([
      { url: 'https://a.example/api/stats', auth: 'Bearer server-a' },
      { url: 'https://a.example/agent/control/status', auth: 'Bearer agent-a' },
    ]);
    expect(bq.agentBase).toBe('https://a.example/agent');
  });

  test('persists bounded profile metadata but never either token', () => {
    useConnectionStore.getState().saveConnection({
      name: 'Primary',
      baseUrl: 'https://primary.example',
      agentBaseUrl: 'https://primary.example/agent',
      token: 'server-secret',
      agentToken: 'agent-secret',
    });
    const projected = persistedConnectionState(useConnectionStore.getState());
    expect(projected.profiles).toEqual([
      {
        id: 'default',
        name: 'Primary',
        baseUrl: 'https://primary.example',
        agentBaseUrl: 'https://primary.example/agent',
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain('secret');
    expect(localStorage.getItem(CONNECTION_STORAGE_KEY)).not.toContain('secret');
  });

  test('sanitizes duplicate, malformed and oversized persisted fleets', () => {
    const profiles = Array.from({ length: 40 }, (_, index) => ({
      id: index < 2 ? 'duplicate' : `node-${index}`,
      name: index === 0 ? `\u0000 ${'x'.repeat(80)}` : `Node ${index}`,
      baseUrl: index === 3 ? '//attacker.example' : `https://node-${index}.example/api/`,
      agentBaseUrl: index === 4 ? 'file:///tmp/agent' : `https://node-${index}.example/agent/`,
    }));
    const safe = sanitizedPersistedConnectionState({
      profiles,
      activeProfileId: 'missing',
      refreshMs: 100_000,
      token: 'legacy-server',
      agentToken: 'legacy-agent',
    });
    expect(safe.profiles).toHaveLength(30);
    expect(new Set(safe.profiles.map((profile) => profile.id)).size).toBe(30);
    expect(safe.profiles[0].name).toHaveLength(64);
    expect(safe.profiles.some((profile) => profile.baseUrl.includes('attacker'))).toBe(false);
    expect(safe.profiles.find((profile) => profile.id === 'node-4')?.agentBaseUrl).toBe(
      'http://localhost:6800'
    );
    expect(safe.activeProfileId).toBe('duplicate');
    expect(safe.refreshMs).toBe(60_000);
    expect(JSON.stringify(safe)).not.toContain('legacy');
  });

  test('captures inactive credentials and refuses unknown or final-profile deletion', () => {
    const added = useConnectionStore.getState().addProfile({
      name: 'Second',
      baseUrl: 'https://second.example',
      agentBaseUrl: 'https://second.example/agent',
      token: 'server-two',
      agentToken: 'agent-two',
    });
    const id = added.id as string;
    useConnectionStore.getState().activateProfile('default');
    expect(captureConnectionProfileTarget(id)).toMatchObject({
      id,
      token: 'server-two',
      agentToken: 'agent-two',
    });
    expect(captureConnectionProfileTarget('missing')).toBeNull();
    expect(useConnectionStore.getState().removeProfile(id)).toBe(true);
    expect(useConnectionStore.getState().removeProfile('default')).toBe(false);
  });
});
