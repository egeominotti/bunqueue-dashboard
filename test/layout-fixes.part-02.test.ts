import { describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useCopilotStore } from '../src/components/dashboard/stores/copilotStore';
import { useGlobalModalStore } from '../src/components/dashboard/stores/globalModalStore';
import { AppLayout } from '../src/components/layout/AppLayout';
import { ensureDom, settle } from './domSetup';

describe('global modal arbitration', () => {
  test('palette and authentication replace lower-priority dialogs without overlapping traps', async () => {
    ensureDom();
    useGlobalModalStore.getState().reset();
    useCopilotStore.getState().setOpen(false);
    useConnectionStore.setState({ baseUrl: 'http://server.test', token: '' });
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const previousMatchMedia = window.matchMedia;
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0) as unknown as number;
    globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
    window.matchMedia = (() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
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

      act(() =>
        host
          .querySelector<HTMLButtonElement>('[aria-label="Open Copilot"]')
          ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      );
      await settle(30);
      expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1);

      act(() => window.dispatchEvent(new window.Event('command-palette:open')));
      await settle(10);
      const commandDialogs = host.querySelectorAll<HTMLElement>('[role="dialog"]');
      expect(commandDialogs).toHaveLength(1);
      expect(commandDialogs[0]?.getAttribute('aria-label')).toBe('Command palette');
      expect(useCopilotStore.getState().open).toBe(false);
      expect(host.querySelector<HTMLElement>('#copilot-layer')?.inert).toBe(true);

      act(() =>
        window.dispatchEvent(
          new window.CustomEvent('auth:required', {
            detail: { scope: 'server', auth: undefined, target: 'http://server.test' },
          })
        )
      );
      await settle(10);
      const authDialogs = host.querySelectorAll<HTMLElement>('[role="dialog"]');
      expect(authDialogs).toHaveLength(1);
      expect(authDialogs[0]?.getAttribute('aria-label')).toBe('Authentication required');

      // A lower-priority keyboard surface cannot hide the credential gate.
      act(() => window.dispatchEvent(new window.Event('command-palette:open')));
      await settle(5);
      expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
        'Authentication required'
      );
    } finally {
      act(() => root.unmount());
      host.remove();
      useGlobalModalStore.getState().reset();
      useCopilotStore.getState().setOpen(false);
      useConnectionStore.setState({ baseUrl: '/api', token: '' });
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
  });
});
