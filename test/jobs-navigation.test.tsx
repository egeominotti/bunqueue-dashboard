import { Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  act,
  useConnectionStore,
  buttonByText,
  clickSameTick,
  createElement,
  describe,
  expect,
  installTestHooks,
  JobsPro,
  json,
  MemoryRouter,
  queueSummary,
  render,
  settle,
  test,
} from './server-action-pages.helpers';

installTestHooks();

function NavigateToEmails() {
  const navigate = useNavigate();
  return createElement(
    'button',
    { type: 'button', onClick: () => navigate('/jobs?queue=emails&status=active') },
    'Open emails'
  );
}

describe('Jobs navigation', () => {
  test('batched server A to B to A immediately refetches rows for the new view generation', async () => {
    let listRequests = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/queues/summary')) {
        return Promise.resolve(json([queueSummary('orders')]));
      }
      if (url.pathname.endsWith('/stats')) return Promise.resolve(json({ ok: false }, 503));
      if (url.pathname.endsWith('/queues/orders/jobs/list')) {
        listRequests++;
        return Promise.resolve(
          json({
            ok: true,
            jobs: [
              {
                id: `fresh-generation-${listRequests}`,
                queue: 'orders',
                state: 'delayed',
              },
            ],
          })
        );
      }
      return Promise.resolve(json({ ok: false, error: 'Unexpected request' }, 500));
    }) as typeof fetch;
    const view = render(
      createElement(
        MemoryRouter,
        {
          initialEntries: ['/jobs?queue=orders&status=delayed'],
        },
        createElement(JobsPro)
      )
    );
    try {
      await settle(40);
      expect(listRequests).toBe(1);
      expect(view.host.textContent).toContain('fresh-generation-1');
      act(() => {
        useConnectionStore.setState({ baseUrl: 'http://server-b.test' });
        useConnectionStore.setState({ baseUrl: 'http://server-a.test' });
      });
      await settle(40);
      expect(listRequests).toBe(2);
      expect(view.host.textContent).toContain('fresh-generation-2');
      expect(view.host.textContent).not.toContain('fresh-generation-1');
    } finally {
      view.unmount();
    }
  });

  test('changing query parameters in the same route updates the selected queue, state and jobs', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/queues/summary')) {
        return Promise.resolve(json([queueSummary('orders'), queueSummary('emails')]));
      }
      if (url.endsWith('/stats')) return Promise.resolve(json({ ok: false }, 503));
      if (url.includes('/queues/orders/jobs/list?')) {
        return Promise.resolve(json({ ok: true, jobs: [{ id: 'order-job', queue: 'orders' }] }));
      }
      if (url.includes('/queues/emails/jobs/list?')) {
        return Promise.resolve(
          json({ ok: true, jobs: [{ id: 'email-job', queue: 'emails', state: 'active' }] })
        );
      }
      return Promise.resolve(json({ ok: false, error: 'Unexpected request' }, 500));
    }) as typeof fetch;

    const view = render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/jobs?queue=orders'] },
        createElement(Fragment, null, createElement(JobsPro), createElement(NavigateToEmails))
      )
    );
    try {
      await settle(40);
      expect(view.host.textContent).toContain('order-job');
      clickSameTick(buttonByText(view.host, 'Open emails'), 1);
      await settle(40);
      expect(view.host.querySelector<HTMLSelectElement>('select[name="jobs-queue"]')?.value).toBe(
        'emails'
      );
      expect(view.host.querySelector<HTMLSelectElement>('select[name="jobs-state"]')?.value).toBe(
        'active'
      );
      expect(view.host.textContent).toContain('email-job');
      expect(view.host.textContent).not.toContain('order-job');
    } finally {
      view.unmount();
    }
  });
});
