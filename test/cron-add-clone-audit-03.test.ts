import {
  AddJob,
  act,
  addJobCloneDefaults,
  createElement,
  describe,
  expect,
  installTestHooks,
  json,
  MemoryRouter,
  parseAddJobNumbers,
  render,
  settle,
  test,
} from './cron-add-clone-audit.helpers';

installTestHooks();

describe('AddJob clone fidelity', () => {
  test('structured backoff, tags, group and ttl seed the exact controlled fields', () => {
    expect(
      addJobCloneDefaults({
        backoff: 999,
        backoffConfig: { type: 'exponential', delay: 250 },
        tags: ['billing', 'urgent'],
        groupId: 'tenant-42',
        ttl: 3_600_000,
      })
    ).toEqual({
      backoff: '250',
      backoffType: 'exponential',
      tags: 'billing, urgent',
      groupId: 'tenant-42',
      ttl: '3600000',
    });
    expect(addJobCloneDefaults({})).toEqual({
      backoff: '',
      backoffType: '',
      tags: '',
      groupId: '',
      ttl: '',
    });
  });

  test('ttl follows the exact PUSH bounds without breaking older callers', () => {
    expect(
      parseAddJobNumbers({
        priority: '',
        delay: '',
        maxAttempts: '',
        backoff: '',
        timeout: '',
        ttl: '31536000000',
      })
    ).toEqual({ ok: true, options: { ttl: 31_536_000_000 } });
    expect(
      parseAddJobNumbers({
        priority: '',
        delay: '',
        maxAttempts: '',
        backoff: '',
        timeout: '',
        ttl: '-1',
      }).ok
    ).toBe(false);
    expect(
      parseAddJobNumbers({
        priority: '',
        delay: '',
        maxAttempts: '',
        backoff: '',
        timeout: '',
        ttl: '31536000001',
      }).ok
    ).toBe(false);
    expect(
      parseAddJobNumbers({
        priority: '',
        delay: '',
        maxAttempts: '',
        backoff: '',
        timeout: '',
      })
    ).toEqual({ ok: true, options: {} });
  });

  test('submitting a clone preserves every newly supported option in the POST body', async () => {
    let posted: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/dashboard/queues?') && method === 'GET') {
        return json({ ok: true, queues: [], total: 0, limit: 500, offset: 0 });
      }
      if (url.endsWith('/queues/emails/jobs') && method === 'POST') {
        posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ ok: true, id: 'fresh-clone' });
      }
      return json({ ok: false, error: `Unexpected ${method} ${url}` }, 500);
    }) as typeof fetch;

    const view = render(
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            {
              pathname: '/jobs/add',
              state: {
                clone: {
                  queue: 'emails',
                  dataText: '{"message":"hello"}',
                  options: {
                    backoff: 999,
                    backoffConfig: { type: 'fixed', delay: 1250 },
                    tags: ['mail', 'priority'],
                    groupId: 'tenant-a',
                    ttl: 60_000,
                  },
                },
              },
            },
          ],
        },
        createElement(AddJob)
      )
    );
    await settle(10);

    expect(view.host.querySelector<HTMLInputElement>('[name="backoff"]')?.value).toBe('1250');
    expect(view.host.querySelector<HTMLSelectElement>('[name="backoff-strategy"]')?.value).toBe(
      'fixed'
    );
    expect(view.host.querySelector<HTMLInputElement>('[name="tags"]')?.value).toBe(
      'mail, priority'
    );
    expect(view.host.querySelector<HTMLInputElement>('[name="group-id"]')?.value).toBe('tenant-a');
    expect(view.host.querySelector<HTMLInputElement>('[name="ttl"]')?.value).toBe('60000');

    act(() =>
      view.host
        .querySelector('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    );
    await settle(15);
    expect(posted).toMatchObject({
      data: { message: 'hello' },
      backoff: { type: 'fixed', delay: 1250 },
      tags: ['mail', 'priority'],
      groupId: 'tenant-a',
      ttl: 60_000,
    });
    view.unmount();
  });
});
