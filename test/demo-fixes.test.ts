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
import { afterAll, describe, expect, mock, test } from 'bun:test';
import './domSetup';

const INSTALL_PATH = `${import.meta.dir}/../src/lib/demo/install.ts`;

// A second, unmocked instance of the shim (the query suffix makes it a distinct
// module key), so the main.tsx test below can mock the plain specifier — which
// is what main.tsx imports — without disarming this one.
const installModule = (await import(`${INSTALL_PATH}?real=1`)) as {
  installDemo: () => void;
};

// The shim resolves request URLs against window.location.origin, which happy-dom
// leaves as "null" (about:blank) — give it a real one before installing.
const previousHref = window.location.href;
const previousFetch = window.fetch;
window.location.href = 'http://localhost:5273/';
installModule.installDemo();

afterAll(() => {
  window.location.href = previousHref;
  window.fetch = previousFetch;
  // `bun test` shares one process across files: undo the module mock so no other
  // file inherits a throwing ./lib/demo/install.
  mock.module(INSTALL_PATH, () => installModule);
});

async function apiJson(path: string): Promise<Record<string, unknown>> {
  // The shim patches window.fetch — that is what the app calls.
  const res = await window.fetch(`http://127.0.0.1:6790${path}`);
  return (await res.json()) as Record<string, unknown>;
}

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

describe('main.tsx demo boot', () => {
  test('a failed demo chunk shows an error instead of demo chrome', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    window.location.href = 'http://localhost:5273/?demo';
    mock.module(INSTALL_PATH, () => {
      throw new Error('chunk 404');
    });

    // main.tsx runs its boot on import; the rejected dynamic import must land in
    // the visible-failure branch instead of being swallowed and rendered anyway.
    await import('../src/main');
    await new Promise((r) => setTimeout(r, 50));

    const text = root.textContent ?? '';
    expect(text).toContain('Demo data failed to load');
    expect(text).toContain('chunk 404');
    // The app itself must NOT have rendered (no demo badge, no CTA, no sidebar).
    expect(root.querySelector('nav')).toBeNull();
  });
});
