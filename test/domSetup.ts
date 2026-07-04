/**
 * Minimal DOM environment + hook harness for testing React hooks under
 * `bun test` without pulling in @testing-library. A happy-dom Window supplies
 * `document`/`window` (only what react-dom needs — Bun's own fetch/timers stay
 * untouched, so tests that mock `globalThis.fetch` or hit real sockets keep
 * working), and `renderHook` mounts the hook in a throwaway root under
 * React's act() so state updates flush deterministically.
 *
 * `bun test` runs every file in one process with a shared global scope, so the
 * DOM installed here persists for later files — call `ensureDom()` (or just
 * import this module) rather than assuming another file already set it up.
 */
import { Window as HappyWindow } from 'happy-dom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

declare global {
  // React's act() refuses to run (and warns) unless this flag is set.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

export function ensureDom(): void {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  if (typeof globalThis.document !== 'undefined') return;
  const win = new HappyWindow();
  globalThis.window = win as unknown as typeof globalThis.window;
  globalThis.document = win.document as unknown as Document;
}

ensureDom();

export interface HookHandle<T, P> {
  /** Latest return value of the hook (updated on every render). */
  result: { current: T };
  /** Re-render, optionally with new props (for hooks that take deps/args). */
  rerender: (nextProps?: P) => void;
  unmount: () => void;
}

export function renderHook<T, P = void>(
  useHook: (props: P) => T,
  initialProps?: P
): HookHandle<T, P> {
  ensureDom();
  const result = { current: undefined as T };
  let props = initialProps as P;
  function Probe(): null {
    result.current = useHook(props);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe)));
  return {
    result,
    rerender: (nextProps?: P) => {
      if (nextProps !== undefined) props = nextProps;
      act(() => root.render(createElement(Probe)));
    },
    unmount: () => act(() => root.unmount()),
  };
}

/**
 * Let real timers/promises run for `ms` inside act(), so any state updates they
 * cause are flushed before the test asserts.
 */
export async function settle(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
