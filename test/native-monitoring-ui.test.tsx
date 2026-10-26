import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { MonitoringSetup } from '../src/features/monitoring/MonitoringSetup';
import { ensureDom, settle } from './domSetup';

let originalConnection: ReturnType<typeof useConnectionStore.getState>;
let originalLocation: string;
const mounted = new Set<() => void>();

beforeEach(() => {
  ensureDom();
  originalConnection = useConnectionStore.getState();
  originalLocation = window.location.href;
  window.location.href = 'https://dashboard.test/team/';
  useConnectionStore.setState({
    baseUrl: '/api',
    token: 'server-private-token',
    agentToken: 'agent-private-token',
  });
});
afterEach(() => {
  for (const unmount of mounted) unmount();
  mounted.clear();
  useConnectionStore.setState(originalConnection, true);
  window.location.href = originalLocation;
});

function render() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(MemoryRouter, {}, createElement(MonitoringSetup))));
  mounted.add(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}
function button(host: HTMLElement, text: string) {
  return [...host.querySelectorAll('button')].find((item) => item.textContent === text);
}
function change(host: HTMLElement, name: string, value: string) {
  const input = host.querySelector(`input[name="${name}"]`) as HTMLInputElement;
  expect(input).not.toBeNull();
  const key = Object.keys(input).find((item) => item.startsWith('__reactProps$'))!;
  const props = (input as unknown as Record<string, { onChange: (event: unknown) => void }>)[key];
  act(() => props.onChange({ target: { value } }));
}

describe('native monitoring setup screen', () => {
  test('resolves the native proxy endpoint and separates the three monitoring capabilities', () => {
    const host = render();
    expect(host.querySelector('h1')?.textContent).toBe('Monitoring setup');
    expect(host.querySelector('a[data-native-prometheus]')?.getAttribute('href')).toBe(
      'https://dashboard.test/api/prometheus'
    );
    expect(host.querySelector('input[name="scrape-url"]')?.getAttribute('value')).toBe(
      'https://dashboard.test/api/prometheus'
    );
    expect(host.querySelector('a[href="/webhooks"]')?.textContent).toContain('Native job events');
    expect(host.querySelector('a[href="/alerts"]')?.textContent).toContain('Browser rules');
    expect(host.textContent).toContain('open tab');
    expect(host.textContent).toContain('external Prometheus + Alertmanager');
    expect(host.textContent).toContain('reachable from the Prometheus server');
    expect(host.textContent).toContain('METRICS_AUTH');
    expect(host.textContent).toContain('AUTH_TOKENS');
    expect(host.innerHTML).not.toContain('server-private-token');
    expect(host.innerHTML).not.toContain('agent-private-token');
  });

  test('refreshes the native endpoint and export defaults after a server change', () => {
    const host = render();
    change(host, 'scrape-url', 'https://external.test/prometheus');
    act(() => useConnectionStore.setState({ baseUrl: 'https://new.test/proxy/api/' }));
    expect(host.querySelector('a[data-native-prometheus]')?.getAttribute('href')).toBe(
      'https://new.test/proxy/api/prometheus'
    );
    expect((host.querySelector('input[name="scrape-url"]') as HTMLInputElement).value).toBe(
      'https://new.test/proxy/api/prometheus'
    );
  });

  test('copies the edited configuration and downloads both real YAML artifacts without requests', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalClick = window.HTMLAnchorElement.prototype.click;
    const originalFetch = globalThis.fetch;
    const copied: string[] = [];
    const files: Blob[] = [];
    const names: string[] = [];
    let requests = 0;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          copied.push(value);
        },
      },
    });
    URL.createObjectURL = (blob) => {
      files.push(blob as Blob);
      return 'blob:monitoring-test';
    };
    URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function () {
      names.push(this.download);
    };
    globalThis.fetch = (async () => {
      requests += 1;
      throw new Error('Unexpected network');
    }) as typeof fetch;
    try {
      const host = render();
      change(host, 'scrape-url', 'http://metrics.internal:6790/proxy/prometheus');
      change(host, 'scrape-job-name', 'production');
      act(() => (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
      const copy = host.querySelector(
        'button[aria-label="Copy to clipboard"]'
      ) as HTMLButtonElement;
      expect(copy).not.toBeNull();
      act(() => copy.click());
      await settle(1);
      expect(copied[0]).toContain('targets: ["metrics.internal:6790"]');
      expect(copied[0]).toContain('metrics_path: "/proxy/prometheus"');
      expect(copied[0]).toContain('bearer_token_file: "/etc/prometheus/secrets/bunqueue-token"');
      act(() => button(host, 'Download scrape config')?.click());
      act(() => button(host, 'Download alert rules')?.click());
      expect(names).toEqual(['bunqueue-prometheus.yml', 'bunqueue-alerts.yml']);
      expect(await files[0]?.text()).toBe(copied[0]);
      const alerts = (await files[1]?.text()) ?? '';
      expect(alerts).toContain('bunqueue_jobs_waiting');
      expect(alerts).toContain('production');
      expect(alerts).not.toContain('server-private-token');
      expect(requests).toBe(0);
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      window.HTMLAnchorElement.prototype.click = originalClick;
      globalThis.fetch = originalFetch;
    }
  });

  test('shows validation errors and removes copy/export controls for unsafe edits', () => {
    const host = render();
    change(host, 'scrape-url', 'https://user:secret@queue.test/prometheus');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'without embedded credentials'
    );
    expect(host.querySelector('[aria-label="Copy to clipboard"]')).toBeNull();
    expect(button(host, 'Download scrape config')).toBeUndefined();
    expect(button(host, 'Download alert rules')).toBeUndefined();
    change(host, 'scrape-url', 'https://queue.test/prometheus?token=secret');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('query or a fragment');
    change(host, 'scrape-url', 'https://queue.test/prometheus');
    change(host, 'scrape-job-name', 'bad\njob');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('job name');
    change(host, 'scrape-job-name', 'valid');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(button(host, 'Download scrape config')).toBeDefined();
  });

  test('previews decoded proxy paths and rejects ambiguous encoded path separators', () => {
    const host = render();
    change(host, 'scrape-url', 'https://queue.test/team%20one/東京/prometheus');
    expect(host.querySelector('pre')?.textContent).toContain(
      'metrics_path: "/team one/東京/prometheus"'
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
    change(host, 'scrape-url', 'https://queue.test/team%2Fone/prometheus');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('encoded path separators');
    expect(host.querySelector('[aria-label="Copy to clipboard"]')).toBeNull();
    expect(button(host, 'Download scrape config')).toBeUndefined();
  });
});
