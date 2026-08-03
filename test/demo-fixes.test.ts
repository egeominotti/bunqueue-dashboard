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
import { bq } from '../src/lib/bq';
import { bootDashboard } from '../src/lib/demo/boot';
import { loadJobForLookup } from '../src/pages/control/JobInspector';
import './domSetup';

const INSTALL_PATH = `${import.meta.dir}/../src/lib/demo/install.ts`;

// A distinct module key keeps this global fetch shim isolated from the module
// that production main.tsx loads in case another test imports the entry point.
const installModule = (await import(`${INSTALL_PATH}?real=1`)) as {
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

async function apiJson(path: string): Promise<Record<string, unknown>> {
  // The shim patches window.fetch — that is what the app calls.
  const res = await window.fetch(`http://127.0.0.1:6790${path}`);
  return (await res.json()) as Record<string, unknown>;
}

const apiResponse = (path: string): Promise<Response> =>
  window.fetch(`http://127.0.0.1:6790${path}`);

describe('demo /db/* fixtures are self-consistent', () => {
  test('every listed table serves the advertised row and column counts', async () => {
    const list = (await apiJson('/db/tables')) as unknown as {
      tables: { name: string; rows: number; columns: number }[];
    };
    expect(list.tables.length).toBeGreaterThan(0);

    for (const t of list.tables) {
      const schema = (await apiJson(`/db/tables/${t.name}/schema`)) as unknown as {
        columns: { name: string }[];
        rowCount: number;
      };
      const grid = (await apiJson(`/db/tables/${t.name}?limit=50&offset=0`)) as unknown as {
        columns: string[];
        rows: unknown[][];
        total: number;
      };
      expect(schema.rowCount).toBe(t.rows);
      expect(schema.columns.length).toBe(t.columns);
      expect(grid.total).toBe(t.rows);
      expect(grid.rows.length).toBe(t.rows);
      expect(grid.columns.length).toBe(t.columns);
      // No table falls back to the fabricated placeholder schema.
      expect(grid.columns).not.toEqual(['id', 'data']);
    }
  });

  test('the grid honours orderBy/dir/limit/offset instead of echoing them', async () => {
    const asc = (await apiJson('/db/tables/queues?limit=50&offset=0&orderBy=name&dir=asc')) as {
      rows: string[][];
    };
    const desc = (await apiJson('/db/tables/queues?limit=50&offset=0&orderBy=name&dir=desc')) as {
      rows: string[][];
    };
    const names = asc.rows.map((r) => r[0]);
    expect(names).toEqual([...names].sort());
    expect(desc.rows.map((r) => r[0])).toEqual([...names].reverse());

    const page = (await apiJson('/db/tables/queues?limit=2&offset=1&orderBy=name&dir=asc')) as {
      rows: string[][];
      total: number;
    };
    expect(page.rows.length).toBe(2);
    expect(page.rows.map((r) => r[0])).toEqual(names.slice(1, 3));
    // total stays the full table size, not the page size.
    expect(page.total).toBe(names.length);
  });

  test('/db/info table count matches the served table list', async () => {
    const info = (await apiJson('/db/info')) as unknown as { tables: number };
    const list = (await apiJson('/db/tables')) as unknown as { tables: unknown[] };
    expect(info.tables).toBe(list.tables.length);
  });
});

describe('demo database CSV export contract', () => {
  test('serves raw, length-delimited CSV metadata and neutralizes formula-shaped text', async () => {
    const value = encodeURIComponent('=SUM(1,2)');
    const res = await apiResponse(
      `/db/tables/job_results/export?orderBy=stored_at&dir=desc&fcol=result&fop=eq&fval=${value}`
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-bunqueue-db-export-version')).toBe('1');
    expect(decodeURIComponent(res.headers.get('x-bunqueue-db-export-table') ?? '')).toBe(
      'job_results'
    );
    expect(res.headers.get('x-bunqueue-db-export-rows')).toBe('1');
    expect(res.headers.get('x-bunqueue-db-export-cap')).toBe('none');
    expect(res.headers.get('access-control-expose-headers')).toContain(
      'X-Bunqueue-Db-Export-Bytes'
    );

    const csv = await res.text();
    expect(csv).toBe(`job_id,result,stored_at\r\ndemo-csv-formula,"'=SUM(1,2)",1783035039400`);
    const bytes = new TextEncoder().encode(csv).byteLength;
    expect(res.headers.get('content-length')).toBe(String(bytes));
    expect(res.headers.get('x-bunqueue-db-export-bytes')).toBe(String(bytes));
  });

  test('applies ordering and each fcol/fop/fval filter to the exported snapshot', async () => {
    const cases = [
      { op: 'eq', value: 'emails', expected: ['emails'] },
      {
        op: 'contains',
        value: 'I',
        expected: ['notifications', 'image-processing', 'emails'],
      },
      { op: 'ne', value: 'emails', expected: ['reports', 'notifications', 'image-processing'] },
    ] as const;

    for (const { op, value, expected } of cases) {
      const res = await apiResponse(
        `/db/tables/queues/export?orderBy=name&dir=desc&fcol=name&fop=${op}&fval=${encodeURIComponent(value)}`
      );
      expect(res.status).toBe(200);
      const [header, ...rows] = (await res.text()).split('\r\n');
      expect(header).toBe('name,paused,concurrency,rate_limit');
      expect(rows.map((row) => row.split(',')[0])).toEqual(expected);
      expect(res.headers.get('x-bunqueue-db-export-rows')).toBe(String(expected.length));
    }
  });

  test('is accepted end-to-end by the production bq export validator', async () => {
    const previousGlobalFetch = globalThis.fetch;
    globalThis.fetch = window.fetch;
    try {
      const exported = await bq.getDbExportAtTarget(bq.captureAgentRequestTarget(), {
        table: 'queues',
        orderBy: 'name',
        dir: 'asc',
        filter: { column: 'name', op: 'ne', value: 'reports' },
      });
      expect(exported).toMatchObject({
        table: 'queues',
        rowCount: 3,
        cap: null,
      });
      expect(exported.content.byteLength).toBe(exported.bytes);
      expect(new TextDecoder().decode(exported.content)).toContain(
        'name,paused,concurrency,rate_limit\r\nemails,0,10,0'
      );
    } finally {
      globalThis.fetch = previousGlobalFetch;
    }
  });

  test('rejects ambiguous export options instead of returning JSON as CSV', async () => {
    const res = await apiResponse('/db/tables/queues/export?dir=asc&dir=desc');
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toMatchObject({ ok: false });
  });
});

describe('demo transport lifecycle', () => {
  test('cleanup is idempotent, restores the exact fetch, and permits reinstall', async () => {
    const lifecycleModule = (await import(`${INSTALL_PATH}?lifecycle=1`)) as {
      installDemo: () => () => void;
    };
    const before = window.fetch;

    const firstCleanup = lifecycleModule.installDemo();
    expect(window.fetch).not.toBe(before);
    firstCleanup();
    firstCleanup();
    expect(window.fetch).toBe(before);

    const secondCleanup = lifecycleModule.installDemo();
    expect(window.fetch).not.toBe(before);
    secondCleanup();
    expect(window.fetch).toBe(before);
  });
});

describe('demo fail-closed dashboard payloads', () => {
  test('queue summary survives the production parser with prioritized counts', async () => {
    const previousGlobalFetch = globalThis.fetch;
    globalThis.fetch = window.fetch;
    try {
      const summary = await bq.queuesSummary();
      expect(summary.map((queue) => queue.name)).toEqual([
        'emails',
        'image-processing',
        'reports',
        'notifications',
      ]);
      expect(summary.reduce((total, queue) => total + queue.counts.prioritized, 0)).toBe(7);
    } finally {
      globalThis.fetch = previousGlobalFetch;
    }
  });

  test('the other strict collection parsers accept their demo contracts', async () => {
    const previousGlobalFetch = globalThis.fetch;
    globalThis.fetch = window.fetch;
    try {
      const [workers, webhooks] = await Promise.all([bq.workers(), bq.webhooks()]);
      expect(workers).toMatchObject({
        ok: true,
        data: { quarantinedWorkers: [], stats: { total: 3, active: 2 } },
      });
      expect(workers.data.workers).toHaveLength(3);
      expect(webhooks).toMatchObject({
        ok: true,
        data: { webhooks: [{ id: '019f252c-f5e3-7000-883c-28cc5dc157a0' }] },
      });
    } finally {
      globalThis.fetch = previousGlobalFetch;
    }
  });
});

describe('demo Job Inspector contract', () => {
  test('canonical and custom lookups survive the production envelope validators', async () => {
    const previousGlobalFetch = globalThis.fetch;
    globalThis.fetch = window.fetch;
    try {
      const direct = await loadJobForLookup('demo-inspector-job', 'id', {
        target: { baseUrl: 'http://127.0.0.1:6790' },
      });
      expect(direct).toMatchObject({
        id: 'demo-inspector-job',
        queue: 'emails',
        state: 'failed',
      });

      const custom = await loadJobForLookup('order:demo-42', 'custom', {
        target: { baseUrl: 'http://127.0.0.1:6790' },
      });
      expect(custom).toMatchObject({
        id: 'demo-custom:order:demo-42',
        customId: 'order:demo-42',
        state: 'failed',
      });

      const result = await apiJson('/jobs/demo-inspector-job/result');
      expect(result).toMatchObject({ ok: true, id: 'demo-inspector-job' });
    } finally {
      globalThis.fetch = previousGlobalFetch;
    }
  });
});

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
