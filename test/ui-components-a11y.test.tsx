import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, IconButton } from '../src/components/ui/Button';
import { CopyButton } from '../src/components/ui/CopyButton';
import { ErrorState, LoadingState, OfflineBanner, Spinner } from '../src/components/ui/feedback';
import { Input, SegmentedControl, Toggle } from '../src/components/ui/form';
import { ensureDom, settle } from './domSetup';

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

let clipboardDescriptor: PropertyDescriptor | undefined;
let execCommandDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  ensureDom();
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
});

afterEach(() => {
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
  if (execCommandDescriptor) {
    Object.defineProperty(document, 'execCommand', execCommandDescriptor);
  } else {
    Reflect.deleteProperty(document, 'execCommand');
  }
});

describe('segmented-control semantics', () => {
  test('names the group and exposes the selected option as pressed', () => {
    function Harness() {
      const [value, setValue] = useState<'all' | 'active'>('all');
      return createElement(SegmentedControl, {
        options: ['all', 'active'] as const,
        value,
        onChange: setValue,
        label: 'Job status',
      });
    }

    const { host, unmount } = render(createElement(Harness));
    const group = host.querySelector('fieldset');
    const buttons = host.querySelectorAll('button');
    expect(group?.querySelector('legend')?.textContent).toBe('Job status');
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('false');

    act(() => buttons[1]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('false');
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('true');
    unmount();
  });

  test('keeps the existing call signature accessible without a new prop', () => {
    const { host, unmount } = render(
      createElement(SegmentedControl, {
        options: ['spec', 'raw'] as const,
        value: 'spec',
        onChange: () => {},
      })
    );
    expect(host.querySelector('fieldset legend')?.textContent).toBe('View options');
    unmount();
  });
});

describe('async feedback semantics', () => {
  test('announces loading once while leaving the spinner decorative', () => {
    const { host, unmount } = render(createElement(LoadingState, { label: 'Loading jobs…' }));
    const statuses = host.querySelectorAll('[role="status"]');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.getAttribute('aria-live')).toBe('polite');
    expect(statuses[0]?.getAttribute('aria-atomic')).toBe('true');
    expect(statuses[0]?.textContent).toContain('Loading jobs…');
    expect(host.querySelector('[aria-hidden="true"]')).not.toBeNull();
    unmount();
  });

  test('keeps a standalone spinner self-announcing', () => {
    const { host, unmount } = render(createElement(Spinner));
    expect(host.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Loading');
    unmount();
  });

  test('announces offline updates politely and errors assertively', () => {
    const offline = render(createElement(OfflineBanner, { message: 'Refresh failed' }));
    const status = offline.host.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.getAttribute('aria-atomic')).toBe('true');
    offline.unmount();

    const failed = render(createElement(ErrorState, { error: new Error('Server unavailable') }));
    expect(failed.host.querySelector('[role="alert"]')?.getAttribute('aria-atomic')).toBe('true');
    failed.unmount();
  });
});

describe('focus and copy-button feedback', () => {
  test('interactive UI components use a solid accent focus outline', () => {
    const { host, unmount } = render(
      createElement(
        'div',
        {},
        createElement(Input, { 'aria-label': 'Name' }),
        createElement(Button, {}, 'Save'),
        createElement(IconButton, { 'aria-label': 'Close' }, '×'),
        createElement(Toggle, { checked: false, onChange: () => {}, label: 'Enabled' }),
        createElement(SegmentedControl, {
          options: ['all', 'active'] as const,
          value: 'all',
          onChange: () => {},
        }),
        createElement(CopyButton, { value: 'job-1' }),
        createElement(OfflineBanner, { onRetry: () => {} }),
        createElement(ErrorState, { error: new Error('Failed'), onRetry: () => {} })
      )
    );

    for (const control of host.querySelectorAll('input, button')) {
      expect(control.className).toContain('focus-visible:outline-2');
      expect(control.className).toContain('focus-visible:outline-accent');
      expect(control.className).not.toContain('outline-none');
      expect(control.className).not.toContain('ring-accent/50');
    }
    unmount();
  });

  test('updates the accessible name and live message after a successful copy', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
    const { host, unmount } = render(createElement(CopyButton, { value: 'job-1' }));
    const button = host.querySelector('button');
    expect(button?.getAttribute('aria-label')).toBe('Copy to clipboard');

    act(() => button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await settle(1);
    expect(button?.getAttribute('aria-label')).toBe('Copied to clipboard');
    expect(button?.title).toBe('Copied to clipboard');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Copied to clipboard');
    unmount();
  });

  test('updates the accessible name and live message when both copy paths fail', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => false,
    });
    const { host, unmount } = render(createElement(CopyButton, { value: 'job-1' }));
    const button = host.querySelector('button');

    act(() => button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await settle(1);
    expect(button?.getAttribute('aria-label')).toBe('Copy failed');
    expect(button?.title).toBe('Copy failed');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Copy failed');
    unmount();
  });
});
