import {
  CardHeader,
  createElement,
  describe,
  expect,
  Field,
  Input,
  installTestHooks,
  MemoryRouter,
  NAV,
  NavLink,
  NotFound,
  render,
  settle,
  test,
  titleFor,
  useDocumentTitle,
} from './frontend-a11y-fixes.helpers';

installTestHooks();

describe('form and heading semantics', () => {
  test('a compound Field label targets the actual input', () => {
    const { host, unmount } = render(
      createElement(
        Field,
        { label: 'Token', htmlFor: 'token-input' },
        createElement('div', {}, createElement(Input, { id: 'token-input' }))
      )
    );
    const label = host.querySelector('label');
    expect(label?.htmlFor).toBe('token-input');
    expect(label?.control).toBe(host.querySelector('#token-input'));
    unmount();
  });

  test('CardHeader starts at h2 and supports a nested heading level', () => {
    const { host, unmount } = render(
      createElement(
        'div',
        {},
        createElement(CardHeader, { title: 'Top card' }),
        createElement(CardHeader, { title: 'Nested card', headingLevel: 4 })
      )
    );
    expect(host.querySelector('h2')?.textContent).toBe('Top card');
    expect(host.querySelector('h4')?.textContent).toBe('Nested card');
    unmount();
  });

  test('the 404 code is the page h1', () => {
    const { host, unmount } = render(createElement(MemoryRouter, {}, createElement(NotFound)));
    expect(host.querySelector('h1')?.textContent).toBe('404');
    unmount();
  });
});

describe('route titles and navigation semantics', () => {
  test('classic and pro queue detail titles are decoded without throwing', () => {
    expect(titleFor('/queues/email%20jobs')).toBe('email jobs · Queue');
    expect(titleFor('/queues-classic/email%20jobs')).toBe('email jobs · Queue (classic)');
    expect(titleFor('/queues/%zz')).toContain('%zz');
  });

  test('route titles tolerate trailing slashes', () => {
    expect(titleFor('/settings/')).toBe('Settings');
    expect(titleFor('/queues/email%20jobs/')).toBe('email jobs · Queue');
  });

  test('Topbar keeps document.title in sync with the route', async () => {
    function TitleProbe() {
      useDocumentTitle(titleFor('/database'));
      return null;
    }
    const { unmount } = render(createElement(TitleProbe));
    await settle(1);
    expect(document.title).toBe('Database · bunqueue');
    unmount();
  });

  test('only the exact sidebar destination is aria-current', async () => {
    const items = NAV.flatMap((group) => group.items);
    const jobsItem = items.find((item) => item.to === '/jobs');
    const bulkItem = items.find((item) => item.to === '/jobs/bulk-add');
    const { host, unmount } = render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/jobs/bulk-add'] },
        createElement(
          'nav',
          {},
          createElement(NavLink, { to: jobsItem?.to ?? '', end: jobsItem?.end }, 'Jobs'),
          createElement(NavLink, { to: bulkItem?.to ?? '', end: bulkItem?.end }, 'Bulk Add')
        )
      )
    );
    await settle(1);
    const jobs = host.querySelector<HTMLAnchorElement>('a[href="/jobs"]');
    const bulk = host.querySelector<HTMLAnchorElement>('a[href="/jobs/bulk-add"]');
    expect(jobs?.getAttribute('aria-current')).toBeNull();
    expect(bulk?.getAttribute('aria-current')).toBe('page');
    unmount();
  });
});
