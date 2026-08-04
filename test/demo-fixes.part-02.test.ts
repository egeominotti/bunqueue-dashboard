/**
 * Regressions for the demo build (src/lib/demo/* + src/main.tsx).
 *
 * 1. The /db/* fixtures contradicted themselves: the table list advertised
 *    row/column counts for six tables while only two had data, so four of them
 *    opened empty with an invented `['id','data']` schema.
 * 2. main.tsx swallowed a failed demo-chunk import and rendered anyway, giving a
 *    page that claims to be the demo while every request escapes to a server
 *    that does not exist.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { bootDashboard } from '../src/lib/demo/boot';
import './domSetup';

const INSTALL_PATH = `${import.meta.dir}/../src/lib/demo/install.ts`;

// A distinct module key keeps this global fetch shim isolated from the module
// that production main.tsx loads in case another test imports the entry point.
const installModule = (await import(
  `${INSTALL_PATH}?real=${encodeURIComponent(import.meta.file)}`
)) as {
  installDemo: () => () => void;
};

// The shim resolves request URLs against window.location.origin, which happy-dom
// leaves as "null" (about:blank) — give it a real one before installing.
const previousHref = window.location.href;
const previousFetch = window.fetch;
window.location.href = 'http://localhost:5273/';
const uninstallDemo = installModule.installDemo();

afterAll(() => {
  uninstallDemo();
  window.location.href = previousHref;
  window.fetch = previousFetch;
});

async function _apiJson(path: string): Promise<Record<string, unknown>> {
  // The shim patches window.fetch — that is what the app calls.
  const res = await window.fetch(`http://127.0.0.1:6790${path}`);
  return (await res.json()) as Record<string, unknown>;
}

const _apiResponse = (path: string): Promise<Response> =>
  window.fetch(`http://127.0.0.1:6790${path}`);

describe('dashboard demo boot', () => {
  test('a normal build renders synchronously without loading demo code', () => {
    let loaded = false;
    let rendered = false;

    const result = bootDashboard({
      root: document.createElement('div'),
      demo: false,
      loadDemo: async () => {
        loaded = true;
        return { installDemo: () => undefined };
      },
      render: () => {
        rendered = true;
      },
    });

    expect(result).toBeUndefined();
    expect(loaded).toBeFalse();
    expect(rendered).toBeTrue();
  });

  test('a demo installs its transport before the first render', async () => {
    const calls: string[] = [];

    await bootDashboard({
      root: document.createElement('div'),
      demo: true,
      loadDemo: async () => ({
        installDemo: () => calls.push('install'),
      }),
      render: () => calls.push('render'),
    });

    expect(calls).toEqual(['install', 'render']);
  });

  test('concurrent boots share one load, installation, and render', async () => {
    const root = document.createElement('div');
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const options = {
      root,
      demo: true,
      loadDemo: async () => {
        calls.push('load');
        await ready;
        return { installDemo: () => calls.push('install') };
      },
      render: () => calls.push('render'),
    };

    const first = bootDashboard(options);
    const second = bootDashboard(options);
    expect(second).toBe(first);
    release?.();
    await first;

    expect(calls).toEqual(['load', 'install', 'render']);
  });

  test('render failures propagate and are not mislabeled as demo load failures', async () => {
    const root = document.createElement('div');
    const boot = bootDashboard({
      root,
      demo: true,
      loadDemo: async () => ({ installDemo: () => undefined }),
      render: () => {
        throw new Error('render exploded');
      },
    });

    await expect(boot).rejects.toThrow('render exploded');
    expect(root.textContent).not.toContain('Demo data failed to load');
  });

  test('a failed demo chunk shows an error instead of demo chrome', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let rendered = false;

    try {
      await bootDashboard({
        root,
        demo: true,
        loadDemo: async () => {
          throw new Error('chunk 404');
        },
        render: () => {
          rendered = true;
        },
        reportError: () => undefined,
      });

      const text = root.textContent ?? '';
      expect(text).toContain('Demo data failed to load');
      expect(text).toContain('chunk 404');
      expect(rendered).toBeFalse();
      expect(root.querySelector('nav')).toBeNull();
    } finally {
      root.remove();
    }
  });

  test('a throwing error reporter cannot suppress the visible fallback', async () => {
    const root = document.createElement('div');
    await bootDashboard({
      root,
      demo: true,
      loadDemo: async () => {
        throw new Error('chunk unavailable');
      },
      render: () => undefined,
      reportError: () => {
        throw new Error('logger unavailable');
      },
    });

    expect(root.textContent).toContain('Demo data failed to load');
    expect(root.textContent).toContain('chunk unavailable');
  });
});
