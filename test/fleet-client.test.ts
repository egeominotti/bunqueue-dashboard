import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import {
  postgresTopologyKey,
  probeFleet,
  probeFleetNode,
  runFleetLifecycle,
} from '../src/features/fleet/fleetClient';

const realFetch = globalThis.fetch;
const calls: Array<{ url: string; method: string; auth: string | null }> = [];

function status(name: string, state: 'running' | 'stopped' = 'running') {
  return {
    status: state,
    generation: 1,
    pid: state === 'running' ? 42 : null,
    startedAt: 1,
    exitCode: null,
    healthy: state === 'running',
    storageMode: 'postgres',
    postgresNamespace: 'orders',
    postgresTarget: 'postgres.internal:5432/bunqueue',
    config: { command: name, httpPort: 6790, tcpPort: 6789, dataPath: '', extraEnv: {} },
  };
}

beforeEach(() => {
  calls.length = 0;
  useConnectionStore.setState({
    profiles: [
      {
        id: 'a',
        name: 'Broker A',
        baseUrl: 'https://a.example/api',
        agentBaseUrl: 'https://a.example/agent',
      },
      {
        id: 'b',
        name: 'Broker B',
        baseUrl: 'https://b.example/api',
        agentBaseUrl: 'https://b.example/agent',
      },
    ],
    activeProfileId: 'a',
    baseUrl: 'https://a.example/api',
    agentBaseUrl: 'https://a.example/agent',
    token: 'server-a',
    agentToken: 'agent-a',
  });
  useConnectionStore.getState().setToken('server-a');
  useConnectionStore.getState().setAgentToken('agent-a');
  useConnectionStore.getState().activateProfile('b');
  useConnectionStore.getState().setToken('server-b');
  useConnectionStore.getState().setAgentToken('agent-b');
  useConnectionStore.getState().activateProfile('a');

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, auth: new Headers(init?.headers).get('Authorization') });
    if (url.endsWith('/health')) {
      return Response.json({ ok: true, status: 'healthy', uptime: 1, version: '2.9.3' });
    }
    if (url.includes('/control/')) {
      const broker = url.includes('b.example') ? 'b' : 'a';
      const state = url.endsWith('/start')
        ? 'running'
        : url.endsWith('/stop')
          ? 'stopped'
          : 'running';
      return Response.json(status(broker, state));
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  useConnectionStore.setState({
    profiles: [
      {
        id: 'default',
        name: 'Local Bunqueue',
        baseUrl: '/api',
        agentBaseUrl: 'http://localhost:6800',
      },
    ],
    activeProfileId: 'default',
    baseUrl: '/api',
    agentBaseUrl: 'http://localhost:6800',
    token: '',
    agentToken: '',
  });
});

describe('fleet client', () => {
  test('probes every server and paired agent with the correct isolated credential', async () => {
    const snapshots = await probeFleet(['a', 'b']);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((node) => node.server.healthy && node.agent.reachable)).toBe(true);
    expect(postgresTopologyKey(snapshots[0])).toBe(postgresTopologyKey(snapshots[1]));
    const targetless = structuredClone(snapshots[0]);
    delete targetless.agent.status?.postgresTarget;
    expect(postgresTopologyKey(targetless)).toBeNull();
    expect(calls).toContainEqual({
      url: 'https://a.example/api/health',
      method: 'GET',
      auth: 'Bearer server-a',
    });
    expect(calls).toContainEqual({
      url: 'https://b.example/agent/control/status',
      method: 'GET',
      auth: 'Bearer agent-b',
    });
  });

  test('runs lifecycle against an inactive node without retargeting the active dashboard', async () => {
    const response = await runFleetLifecycle('b', 'stop');
    expect(response.status).toBe('stopped');
    expect(calls.at(-1)).toEqual({
      url: 'https://b.example/agent/control/stop',
      method: 'POST',
      auth: 'Bearer agent-b',
    });
    expect(useConnectionStore.getState().activeProfileId).toBe('a');
  });

  test('isolates endpoint failures and rejects unknown profile identities', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('network down'))) as typeof fetch;
    const snapshot = await probeFleetNode('a');
    expect(snapshot.server).toMatchObject({ reachable: false, error: 'network down' });
    expect(snapshot.agent).toMatchObject({ reachable: false, error: 'network down' });
    await expect(probeFleetNode('missing')).rejects.toThrow('Unknown Bunqueue connection profile');
    await expect(runFleetLifecycle('missing', 'restart')).rejects.toThrow(
      'Unknown Bunqueue connection profile'
    );
    expect(postgresTopologyKey(snapshot)).toBeNull();
  });
});
