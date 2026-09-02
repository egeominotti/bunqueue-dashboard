import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { Fleet } from '../src/pages/Fleet';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;
const mounted = new Set<() => void>();
const calls: Array<{ url: string; method: string }> = [];
const states = new Map([
  ['a', 'running'],
  ['b', 'stopped'],
]);

function agentStatus(name: string) {
  const state = states.get(name) ?? 'stopped';
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

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const unmount = () => {
    act(() => root.unmount());
    host.remove();
    mounted.delete(unmount);
  };
  mounted.add(unmount);
  act(() => root.render(element));
  return host;
}

function button(host: ParentNode, label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function nodeCard(host: ParentNode, name: string): HTMLElement {
  const heading = [...host.querySelectorAll('h2')].find(
    (candidate) => candidate.textContent?.trim() === name
  );
  const card = heading?.closest<HTMLElement>('.rounded-xl');
  if (!card) throw new Error(`Missing node card: ${name}`);
  return card;
}

beforeEach(() => {
  ensureDom();
  calls.length = 0;
  states.set('a', 'running');
  states.set('b', 'stopped');
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
    token: '',
    agentToken: '',
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (url.endsWith('/health')) {
      return Response.json({ ok: true, status: 'healthy', uptime: 1, version: '2.9.3' });
    }
    const name = url.includes('b.example') ? 'b' : 'a';
    if (url.endsWith('/control/start')) states.set(name, 'running');
    return Response.json(agentStatus(name));
  }) as typeof fetch;
});

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
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

describe('Fleet page', () => {
  test('shows a shared PostgreSQL topology and operates an inactive broker', async () => {
    const host = render(createElement(Fleet));
    await settle(20);

    expect(host.textContent).toContain('Configured nodes2');
    expect(host.textContent).toContain('Healthy APIs2/2');
    expect(host.textContent).toContain('PostgreSQL clusters1');
    expect(host.textContent).toContain('postgres.internal:5432/bunqueue');
    expect(host.textContent).toContain('Broker A, Broker B');

    const brokerB = nodeCard(host, 'Broker B');
    act(() => button(brokerB, 'Start').click());
    await settle(20);
    expect(calls).toContainEqual({
      url: 'https://b.example/agent/control/start',
      method: 'POST',
    });
    expect(states.get('b')).toBe('running');

    act(() => button(brokerB, 'Use node').click());
    await settle(20);
    expect(useConnectionStore.getState()).toMatchObject({
      activeProfileId: 'b',
      baseUrl: 'https://b.example/api',
      agentBaseUrl: 'https://b.example/agent',
    });
  });
});
