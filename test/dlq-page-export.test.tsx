import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { DlqPro } from '../src/pages/control/DlqPro';
import {
  button,
  click,
  change,
  byName,
  render,
  settle,
  waitFor,
  installStableFixHooks,
} from './control-pages-stable-fixes.helpers';

installStableFixHooks();
const realFetch = globalThis.fetch;
const createObjectURL = URL.createObjectURL;
let server: ReturnType<typeof Bun.serve>;
let downloads: Blob[];
let filenames: string[];
let requests: string[];
const captureDownload = (event: Event) => {
  const anchor = event.target as HTMLAnchorElement;
  if (anchor.tagName === 'A' && anchor.download) {
    event.preventDefault();
    filenames.push(anchor.download);
  }
};
beforeEach(() => {
  downloads = [];
  filenames = [];
  requests = [];
  const records = Array.from({ length: 30 }, (_, index) => ({
    job: { id: `failed-${index}`, queue: 'orders', attempts: 1 },
    reason: 'max_attempts',
    error: index === 0 ? '=1+1' : 'processor failed',
    enteredAt: 1000 + index,
    attempts: [{ timestamp: 1000, error: 'processor failed' }],
  }));
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      if (url.pathname === '/dashboard/queues')
        return Response.json({
          ok: true,
          queues: [{ name: 'orders', waiting: 0, active: 0, delayed: 0, dlq: 30, paused: false }],
          total: 1,
          limit: 500,
          offset: 0,
          timestamp: Date.now(),
        });
      if (url.pathname.endsWith('/dlq/stats'))
        return Response.json({
          ok: true,
          stats: { byReason: { max_attempts: 30 }, pendingRetry: 0 },
        });
      if (url.pathname.endsWith('/dlq')) {
        const offset = Number(url.searchParams.get('offset'));
        const limit = Number(url.searchParams.get('limit'));
        return Response.json({
          ok: true,
          entries: records.slice(offset, offset + limit),
          total: 30,
        });
      }
      return Response.json({ ok: false, error: 'Unexpected request' }, { status: 404 });
    },
  });
  globalThis.fetch = realFetch;
  useConnectionStore.setState({
    baseUrl: `http://127.0.0.1:${server.port}`,
    token: '',
    agentToken: '',
    refreshMs: 60000,
  });
  URL.createObjectURL = (blob: Blob) => {
    downloads.push(blob);
    return createObjectURL(blob);
  };
  document.addEventListener('click', captureDownload, true);
});
afterEach(() => {
  server.stop(true);
  globalThis.fetch = realFetch;
  URL.createObjectURL = createObjectURL;
  document.removeEventListener('click', captureDownload, true);
});

test('DLQ download visibly identifies the loaded page and exports its 25 then 5 rows only', async () => {
  const view = render(
    createElement(MemoryRouter, { initialEntries: ['/dlq?queue=orders'] }, createElement(DlqPro))
  );
  await waitFor(() => view.host.textContent?.includes('failed-24') === true);
  const exportButton = button(view.host, 'Export page CSV');
  expect(exportButton.title).toContain('visible rows');
  const beforeExport = requests.length;
  click(exportButton);
  await settle(2);
  expect(requests.length).toBe(beforeExport);
  const first = await downloads[0].text();
  expect(first.trim().split('\n')).toHaveLength(26);
  expect(first).toContain("'=1+1");
  expect(filenames[0]).toBe('dlq-orders-page-1.csv');
  expect(first).not.toContain('failed-25,');
  click(button(view.host, 'Next'));
  await waitFor(() => view.host.textContent?.includes('failed-29') === true);
  click(button(view.host, 'Export page CSV'));
  await settle(2);
  expect((await downloads[1].text()).trim().split('\n')).toHaveLength(6);
  expect(filenames[1]).toBe('dlq-orders-page-2.csv');
  expect(requests.some((request) => !request.startsWith('GET '))).toBe(false);
});

test('DLQ CSV contains only the visible filtered rows in their displayed sort order', async () => {
  const view = render(
    createElement(MemoryRouter, { initialEntries: ['/dlq?queue=orders'] }, createElement(DlqPro))
  );
  await waitFor(() => view.host.textContent?.includes('failed-24') === true);
  change(byName(view.host, 'dlq-job-filter'), 'failed-2');
  await settle(2);
  const visibleIds = [...view.host.querySelectorAll('tbody tr')]
    .map((row) => row.textContent?.match(/failed-\d+/)?.[0])
    .filter(Boolean);
  expect(visibleIds).toEqual([
    'failed-24',
    'failed-23',
    'failed-22',
    'failed-21',
    'failed-20',
    'failed-2',
  ]);
  const beforeExport = requests.length;
  click(button(view.host, 'Export page CSV'));
  await settle(2);
  const csvIds = (await downloads[0].text())
    .trim()
    .split('\n')
    .slice(1)
    .map((row) => row.split(',')[0]);
  expect(csvIds).toEqual(visibleIds);
  change(byName(view.host, 'dlq-sort'), 'oldest');
  await settle(2);
  click(button(view.host, 'Export page CSV'));
  await settle(2);
  expect(
    (await downloads[1].text())
      .trim()
      .split('\n')
      .slice(1)
      .map((row) => row.split(',')[0])
  ).toEqual(['failed-2', 'failed-20', 'failed-21', 'failed-22', 'failed-23', 'failed-24']);
  expect(requests.length).toBe(beforeExport);
  expect(requests.some((request) => !request.startsWith('GET '))).toBe(false);
});
