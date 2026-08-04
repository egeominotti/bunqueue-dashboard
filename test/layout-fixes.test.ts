import { describe, expect, test } from 'bun:test';
import { act, createElement, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useCopilotStore } from '../src/components/dashboard/stores/copilotStore';
import { AppLayout } from '../src/components/layout/AppLayout';
import { useRouteScrollReset } from '../src/lib/useRouteScrollReset';
import { ensureDom, renderHook, settle } from './domSetup';

describe('route scroll restoration', () => {
  test('a new navigation resets both axes of the app scroll container', () => {
    const element = { scrollTop: 240, scrollLeft: 18 } as HTMLElement;
    const ref = { current: element } as RefObject<HTMLElement>;
    const hook = renderHook(
      ({ navigationKey }: { navigationKey: string }) => useRouteScrollReset(ref, navigationKey),
      { navigationKey: 'first' }
    );

    expect(element.scrollTop).toBe(0);
    expect(element.scrollLeft).toBe(0);

    element.scrollTop = 120;
    hook.rerender({ navigationKey: 'first' });
    expect(element.scrollTop).toBe(120);

    hook.rerender({ navigationKey: 'second' });
    expect(element.scrollTop).toBe(0);
    hook.unmount();
  });
});

describe('mobile navigation modal', () => {
  test('moves and traps focus, isolates the background, and restores the opener', async () => {
    ensureDom();
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const previousMatchMedia = window.matchMedia;
    const host = document.createElement('div');
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      // Enter the cleanup boundary before replacing the first shared global:
      // setup failures must be just as isolated as assertion failures.
      globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 0) as unknown as number;
      globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
      window.matchMedia = (() => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      })) as unknown as typeof window.matchMedia;

      document.body.appendChild(host);
      const mountedRoot = createRoot(host);
      root = mountedRoot;
      act(() =>
        mountedRoot.render(
          createElement(
            MemoryRouter,
            { initialEntries: ['/'] },
            createElement(
              Routes,
              {},
              createElement(
                Route,
                { path: '/', element: createElement(AppLayout) },
                createElement(Route, { index: true, element: createElement('h1', {}, 'Page') })
              )
            )
          )
        )
      );

      const opener = host.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]');
      act(() => opener?.click());
      await settle(5);

      const nav = host.querySelector<HTMLElement>('#app-nav');
      const content = host.querySelector<HTMLElement>('#app-content');
      const skipLink = host.querySelector<HTMLAnchorElement>('a[href="#main"]');
      expect(nav?.getAttribute('role')).toBe('dialog');
      expect(nav?.getAttribute('aria-modal')).toBe('true');
      expect(content?.hasAttribute('inert')).toBe(true);
      expect(content?.getAttribute('aria-hidden')).toBe('true');
      expect(skipLink?.inert).toBe(true);
      expect(skipLink?.tabIndex).toBe(-1);
      expect(nav?.contains(document.activeElement)).toBe(true);

      // A raw 401 may be stale. Only AuthGate's correlated acceptance event
      // may dismiss the navigation modal.
      act(() =>
        window.dispatchEvent(
          new window.CustomEvent('auth:required', {
            detail: { scope: 'server', target: 'https://old-server.test/api' },
          })
        )
      );
      await settle(2);
      expect(nav?.getAttribute('role')).toBe('dialog');

      const copilot = host.querySelector<HTMLButtonElement>('[aria-label="Open Copilot"]');
      copilot?.focus();
      act(() =>
        window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
      );
      expect(nav?.contains(document.activeElement)).toBe(true);

      act(() => window.dispatchEvent(new window.Event('auth:gate-opened')));
      await settle(2);
      expect(nav?.getAttribute('role')).toBe('complementary');
      expect(content?.hasAttribute('inert')).toBe(false);
      expect(skipLink?.inert).toBe(false);
      expect(skipLink?.getAttribute('tabindex')).toBeNull();
      expect(document.activeElement).toBe(opener);
    } finally {
      try {
        if (root) act(() => root.unmount());
      } finally {
        host.remove();
        if (previousRequestAnimationFrame) {
          globalThis.requestAnimationFrame = previousRequestAnimationFrame;
        } else {
          Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
        }
        if (previousCancelAnimationFrame) {
          globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
        } else {
          Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
        }
        window.matchMedia = previousMatchMedia;
      }
    }
  });
});

describe('Copilot modal in AppLayout', () => {
  test('isolates the actual shell across its dedicated wrapper and restores it', async () => {
    ensureDom();
    useCopilotStore.getState().setOpen(false);
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0) as unknown as number;
    globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          createElement(
            MemoryRouter,
            { initialEntries: ['/'] },
            createElement(
              Routes,
              {},
              createElement(
                Route,
                { path: '/', element: createElement(AppLayout) },
                createElement(Route, { index: true, element: createElement('h1', {}, 'Page') })
              )
            )
          )
        )
      );

      const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Open Copilot"]');
      act(() => trigger?.click());
      await settle(30);

      const content = host.querySelector<HTMLElement>('#app-content');
      const nav = host.querySelector<HTMLElement>('#app-nav');
      const layer = host.querySelector<HTMLElement>('#copilot-layer');
      expect(host.querySelector('[role="dialog"]')).not.toBeNull();
      expect(content?.inert).toBe(true);
      expect(content?.getAttribute('aria-hidden')).toBe('true');
      expect(nav?.inert).toBe(true);
      expect(layer?.inert).toBe(false);

      act(() =>
        document.dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        )
      );
      await settle(5);
      expect(content?.inert).toBe(false);
      expect(content?.getAttribute('aria-hidden')).toBeNull();
      expect(nav?.inert).toBe(false);
    } finally {
      act(() => root.unmount());
      host.remove();
      useCopilotStore.getState().setOpen(false);
      if (previousRequestAnimationFrame) {
        globalThis.requestAnimationFrame = previousRequestAnimationFrame;
      } else {
        Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
      }
      if (previousCancelAnimationFrame) {
        globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
      } else {
        Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
      }
    }
  });
});
