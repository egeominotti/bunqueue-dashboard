import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AuthGate } from '../src/components/AuthGate';
import { getBaseUrl, useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { bq } from '../src/lib/bq';
import { ensureDom, settle } from './domSetup';

ensureDom();

interface MountedGate {
  container: HTMLDivElement;
  root: Root;
}

function mountGate(): MountedGate {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <AuthGate />
      </MemoryRouter>
    );
  });
  return { container, root };
}

function dispatchAuth(detail: {
  scope?: 'server' | 'agent';
  auth?: string;
  target?: string;
}): void {
  const EventCtor = window.CustomEvent;
  act(() => {
    window.dispatchEvent(new EventCtor('auth:required', { detail }));
  });
}

function unmountGate({ container, root }: MountedGate): void {
  act(() => root.unmount());
  container.remove();
}

function setPasswordValue(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      value
    );
    input.dispatchEvent(
      new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })
    );
  });
}

afterEach(() => {
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
});

describe('AuthGate credential correlation', () => {
  test('ignores a late server 401 issued with a credential that is no longer current', () => {
    useConnectionStore.setState({ baseUrl: 'https://server.test/api', token: 'current-server' });
    const gate = mountGate();
    dispatchAuth({
      scope: 'server',
      auth: 'Bearer stale-server',
      target: 'https://server.test/api',
    });
    expect(gate.container.querySelector('[role="dialog"]')).toBeNull();

    dispatchAuth({
      scope: 'server',
      auth: 'Bearer current-server',
      target: 'https://server.test/api',
    });
    const dialog = gate.container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('bearer token');
    unmountGate(gate);
  });

  test('correlates agent failures against the agent token, independently of server auth', () => {
    useConnectionStore.setState({ token: 'server-token', agentToken: 'new-agent-token' });
    const gate = mountGate();
    dispatchAuth({
      scope: 'agent',
      auth: 'Bearer old-agent-token',
      target: bq.agentBase,
    });
    expect(gate.container.querySelector('[role="dialog"]')).toBeNull();

    dispatchAuth({
      scope: 'agent',
      auth: 'Bearer new-agent-token',
      target: bq.agentBase,
    });
    const dialog = gate.container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('AGENT_TOKEN');
    unmountGate(gate);
  });

  test('drops a no-token 401 that arrives after a token was entered', () => {
    useConnectionStore.setState({ baseUrl: 'https://server.test/api', token: 'replacement' });
    const gate = mountGate();
    dispatchAuth({ scope: 'server', target: 'https://server.test/api' });
    expect(gate.container.querySelector('[role="dialog"]')).toBeNull();
    unmountGate(gate);
  });

  test('ignores a late backend A failure after moving to B with the same token', () => {
    useConnectionStore.setState({ baseUrl: 'https://server-a.test/api', token: 'shared' });
    const gate = mountGate();
    act(() => useConnectionStore.setState({ baseUrl: 'https://server-b.test/api' }));

    dispatchAuth({
      scope: 'server',
      auth: 'Bearer shared',
      target: 'https://server-a.test/api',
    });
    expect(gate.container.querySelector('[role="dialog"]')).toBeNull();

    dispatchAuth({
      scope: 'server',
      auth: 'Bearer shared',
      target: 'https://server-b.test/api',
    });
    expect(gate.container.querySelector('[role="dialog"]')).not.toBeNull();
    unmountGate(gate);
  });

  test('ignores a late backend A failure after moving to B without a token', () => {
    useConnectionStore.setState({ baseUrl: 'https://server-a.test/api', token: '' });
    const gate = mountGate();
    let gateOpened = 0;
    const onGateOpened = () => {
      gateOpened += 1;
    };
    window.addEventListener('auth:gate-opened', onGateOpened);
    try {
      act(() => useConnectionStore.setState({ baseUrl: 'https://server-b.test/api' }));
      dispatchAuth({ scope: 'server', target: 'https://server-a.test/api' });
      expect(gate.container.querySelector('[role="dialog"]')).toBeNull();
      expect(gateOpened).toBe(0);

      // Legacy/malformed events cannot be correlated and fail closed.
      dispatchAuth({ scope: 'server' });
      dispatchAuth({ target: 'https://server-b.test/api' });
      expect(gate.container.querySelector('[role="dialog"]')).toBeNull();
      expect(gateOpened).toBe(0);

      dispatchAuth({ scope: 'server', target: 'https://server-b.test/api' });
      expect(gate.container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(gateOpened).toBe(1);
    } finally {
      window.removeEventListener('auth:gate-opened', onGateOpened);
      unmountGate(gate);
    }
  });

  test('a concurrent server-to-agent 401 cannot reassign the typed server secret', () => {
    useConnectionStore.setState({
      baseUrl: 'https://server.test/api',
      token: '',
      agentToken: '',
    });
    const gate = mountGate();
    dispatchAuth({ scope: 'server', target: 'https://server.test/api' });
    const serverInput = gate.container.querySelector<HTMLInputElement>(
      'input[aria-label="Bearer token"]'
    );
    if (!serverInput) throw new Error('Server token input not found');
    setPasswordValue(serverInput, 'server-secret');

    dispatchAuth({ scope: 'agent', target: bq.agentBase });
    const agentInput = gate.container.querySelector<HTMLInputElement>(
      'input[aria-label="Agent token"]'
    );
    if (!agentInput) throw new Error('Agent token input not found');
    expect(agentInput.value).toBe('');
    expect(gate.container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      true
    );
    expect(useConnectionStore.getState()).toMatchObject({ token: '', agentToken: '' });

    setPasswordValue(agentInput, 'agent-secret');
    const unlock = gate.container.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!unlock) throw new Error('Unlock button not found');
    act(() => unlock.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(useConnectionStore.getState()).toMatchObject({ token: '', agentToken: 'agent-secret' });
    unmountGate(gate);
  });

  test('Settings dismissal erases the draft before a later prompt opens', () => {
    useConnectionStore.setState({ baseUrl: 'https://server.test/api', token: '', agentToken: '' });
    const gate = mountGate();
    dispatchAuth({ scope: 'server', target: 'https://server.test/api' });
    const input = gate.container.querySelector<HTMLInputElement>(
      'input[aria-label="Bearer token"]'
    );
    if (!input) throw new Error('Server token input not found');
    setPasswordValue(input, 'must-not-survive');

    const settings = [...gate.container.querySelectorAll('a')].find((link) =>
      link.textContent?.includes('Open Settings')
    );
    if (!settings) throw new Error('Settings link not found');
    act(() => settings.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(gate.container.querySelector('[role="dialog"]')).toBeNull();

    dispatchAuth({ scope: 'agent', target: bq.agentBase });
    const reopened = gate.container.querySelector<HTMLInputElement>(
      'input[aria-label="Agent token"]'
    );
    expect(reopened?.value).toBe('');
    expect(useConnectionStore.getState()).toMatchObject({ token: '', agentToken: '' });
    unmountGate(gate);
  });

  test('submit revalidates the backend identity after a connection change', () => {
    useConnectionStore.setState({ baseUrl: 'https://server-a.test/api', token: '' });
    const gate = mountGate();
    dispatchAuth({ scope: 'server', target: 'https://server-a.test/api' });
    const input = gate.container.querySelector<HTMLInputElement>(
      'input[aria-label="Bearer token"]'
    );
    if (!input) throw new Error('Server token input not found');
    setPasswordValue(input, 'server-a-secret');
    act(() => useConnectionStore.setState({ baseUrl: 'https://server-b.test/api' }));

    const unlock = gate.container.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!unlock) throw new Error('Unlock button not found');
    act(() => unlock.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(useConnectionStore.getState().token).toBe('');
    expect(gate.container.querySelector('[role="dialog"]')).toBeNull();
    unmountGate(gate);
  });

  test('inerts the app, traps focus, and restores the opener', async () => {
    const nav = document.createElement('aside');
    nav.id = 'app-nav';
    const content = document.createElement('main');
    content.id = 'app-content';
    const opener = document.createElement('button');
    document.body.append(nav, content, opener);
    opener.focus();

    useConnectionStore.setState({ baseUrl: 'https://server.test/api', token: '' });
    const gate = mountGate();
    dispatchAuth({ scope: 'server', target: getBaseUrl() });
    await settle(20);
    expect(nav.inert).toBe(true);
    expect(content.inert).toBe(true);
    expect(nav.getAttribute('aria-hidden')).toBe('true');
    expect(gate.container.querySelector('input')).toBe(document.activeElement);

    unmountGate(gate);
    expect(nav.inert).toBe(false);
    expect(content.inert).toBe(false);
    expect(document.activeElement).toBe(opener);
    nav.remove();
    content.remove();
    opener.remove();
  });
});
