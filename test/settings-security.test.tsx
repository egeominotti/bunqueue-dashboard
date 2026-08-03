import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { Settings } from '../src/pages/Settings';
import { ensureDom, settle } from './domSetup';

interface PendingHealth {
  url: string;
  signal?: AbortSignal | null;
  headers: Headers;
  resolve: (response: Response) => void;
}

const realFetch = globalThis.fetch;
const cleanups: Array<() => void> = [];

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    act(() => root.unmount());
    host.remove();
  };
  cleanups.push(unmount);
  act(() => root.render(element));
  return { host, unmount };
}

function click(host: HTMLElement, label: string): void {
  const button = Array.from(host.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label)
  );
  if (!button) throw new Error(`No button matching "${label}"`);
  act(() => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

function setValue(element: HTMLInputElement, value: string): void {
  const reactPropsKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
  if (!reactPropsKey) throw new Error('React input props were not attached');
  const reactProps = (element as unknown as Record<string, unknown>)[reactPropsKey] as {
    onChange?: (event: { target: HTMLInputElement }) => void;
  };
  if (!reactProps.onChange) throw new Error('React input onChange was not attached');
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      element,
      value
    );
    reactProps.onChange?.({ target: element });
  });
}

function installDeferredHealth(): PendingHealth[] {
  const pending: PendingHealth[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      pending.push({
        url: String(input),
        signal: init?.signal,
        headers: new Headers(init?.headers),
        resolve,
      });
    })) as typeof fetch;
  return pending;
}

async function resolveHealth(request: PendingHealth, version: string): Promise<void> {
  await act(async () => {
    request.resolve(
      Response.json({ ok: true, status: 'healthy', uptime: 42, version }, { status: 200 })
    );
    await Promise.resolve();
  });
}

beforeEach(() => {
  ensureDom();
  useConnectionStore.setState({
    baseUrl: '/api',
    token: '',
    agentToken: '',
    refreshMs: 3000,
  });
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  globalThis.fetch = realFetch;
  useConnectionStore.setState({
    baseUrl: '/api',
    token: '',
    agentToken: '',
    refreshMs: 3000,
  });
});

describe('Settings connection-test lifecycle', () => {
  test('the last-started probe wins even when an older fetch resolves last', async () => {
    const pending = installDeferredHealth();
    const { host } = render(createElement(Settings));

    click(host, 'Test connection');
    expect(pending).toHaveLength(1);
    click(host, 'Restart test');
    expect(pending).toHaveLength(2);
    expect(pending[0]?.signal?.aborted).toBe(true);

    await resolveHealth(pending[1] as PendingHealth, '2.8.56');
    expect(host.textContent).toContain('bunqueue v2.8.56');
    await resolveHealth(pending[0] as PendingHealth, '2.8.55');
    expect(host.textContent).toContain('bunqueue v2.8.56');
    expect(host.textContent).not.toContain('bunqueue v2.8.55');
  });

  test('editing and Save each abort and invalidate the result for the old draft', async () => {
    const pending = installDeferredHealth();
    const { host } = render(createElement(Settings));
    const url = host.querySelector<HTMLInputElement>('input[name="server-url"]');
    expect(url).not.toBeNull();

    click(host, 'Test connection');
    setValue(url as HTMLInputElement, '/api-next');
    expect(pending[0]?.signal?.aborted).toBe(true);
    await resolveHealth(pending[0] as PendingHealth, '2.8.55');
    expect(host.textContent).not.toContain('bunqueue v2.8.55');

    click(host, 'Test connection');
    expect(pending[1]?.url).toBe('/api-next/health');
    click(host, 'Save');
    expect(pending[1]?.signal?.aborted).toBe(true);
    await resolveHealth(pending[1] as PendingHealth, '2.8.56');
    expect(host.textContent).not.toContain('bunqueue v2.8.56');
    expect(host.textContent).toContain('Saved');
  });

  test('an external target/token change aborts the old probe and the next probe uses both new values', async () => {
    const pending = installDeferredHealth();
    const { host } = render(createElement(Settings));
    click(host, 'Test connection');

    act(() => {
      useConnectionStore.setState({
        baseUrl: 'https://server-b.example/api',
        token: 'token-b',
      });
    });
    expect(pending[0]?.signal?.aborted).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[name="server-url"]')?.value).toBe(
      'https://server-b.example/api'
    );
    await resolveHealth(pending[0] as PendingHealth, '2.8.55');
    expect(host.textContent).not.toContain('bunqueue v2.8.55');

    click(host, 'Test connection');
    expect(pending[1]?.url).toBe('https://server-b.example/api/health');
    expect(pending[1]?.headers.get('Authorization')).toBe('Bearer token-b');
    await resolveHealth(pending[1] as PendingHealth, '2.8.56');
    expect(host.textContent).toContain('bunqueue v2.8.56');
  });

  test('unmount aborts the active probe so a late response cannot publish', async () => {
    const pending = installDeferredHealth();
    const { host, unmount } = render(createElement(Settings));
    click(host, 'Test connection');
    unmount();
    expect(pending[0]?.signal?.aborted).toBe(true);
    await resolveHealth(pending[0] as PendingHealth, '2.8.55');
    await settle(1);
    expect(host.textContent).toBe('');
  });
});

describe('Settings save durability', () => {
  test('a quota error reports session-only save instead of crashing or claiming durability', () => {
    const { host } = render(createElement(Settings));
    const storage = globalThis.localStorage;
    const original = Object.getOwnPropertyDescriptor(storage, 'setItem');
    Object.defineProperty(storage, 'setItem', {
      configurable: true,
      value: () => {
        const error = new Error('quota reached');
        error.name = 'QuotaExceededError';
        throw error;
      },
    });
    try {
      click(host, 'Save');
      expect(host.textContent).toContain('Saved for this session only');
      expect(host.textContent).toContain('QuotaExceededError');
    } finally {
      if (original) Object.defineProperty(storage, 'setItem', original);
      else Reflect.deleteProperty(storage, 'setItem');
    }
  });
});
