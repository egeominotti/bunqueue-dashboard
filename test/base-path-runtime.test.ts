import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prefixCssAssetUrls,
  prepareRuntimeIndexHtml,
  resolveBasePath,
  stripBasePath,
} from '../scripts/serve';
import {
  migratePersistedConnectionState,
  resolveDefaultBaseUrl,
} from '../src/components/dashboard/stores/connectionStore';
import { resolveRouterBasename } from '../src/lib/runtimeConfig';
import { handler } from './scripts-fixes.helpers';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('all-in-one runtime base path', () => {
  test('normalizes safe mounts and rejects ambiguous or injectable values', () => {
    expect(resolveBasePath(undefined)).toBe('');
    expect(resolveBasePath('/')).toBe('');
    expect(resolveBasePath(' /internal/queue/ ')).toBe('/internal/queue');
    for (const invalid of [
      'internal/queue',
      '//evil.example',
      '/internal//queue',
      '/internal/../queue',
      '/internal queue',
      '/internal?queue',
      '/internal#queue',
      '/internal/<script>',
    ]) {
      expect(() => resolveBasePath(invalid), invalid).toThrow('BASE_PATH');
    }
  });

  test('mount matching is segment-boundary aware', () => {
    expect(stripBasePath('/internal/queue', '/internal/queue')).toBe('/');
    expect(stripBasePath('/internal/queue/jobs/1', '/internal/queue')).toBe('/jobs/1');
    expect(stripBasePath('/internal/queue-next', '/internal/queue')).toBeNull();
    expect(stripBasePath('/jobs', '')).toBe('/jobs');
  });

  test('injects prefixed router/API/agent settings and build asset URLs', () => {
    const html = prepareRuntimeIndexHtml(
      '<head><base href="/" data-bunqueue-base>' +
        '<link href="/favicon.svg"><script src="./assets/app.js"></script>' +
        '<link href="https://example.com/canonical"></head>',
      '/internal/queue'
    );
    expect(html).toContain('<base href="/internal/queue/" data-bunqueue-base>');
    expect(html).toContain('href="/internal/queue/favicon.svg"');
    expect(html).toContain('src="/internal/queue/assets/app.js"');
    expect(html).toContain('href="https://example.com/canonical"');
    expect(html).toContain('window.__BUNQUEUE_BASE_PATH__="/internal/queue"');
    expect(html).toContain('window.__BUNQUEUE_API_URL__="/internal/queue/api"');
    expect(html).toContain('window.__BUNQUEUE_AGENT_URL__="/internal/queue/agent"');
  });

  test('prefixes Vite root-relative CSS assets with or without quotes', () => {
    const css = 'a{src:url(/assets/a.woff2)}b{src:url("/assets/b.woff2")}c{src:url(data:x)}';
    expect(prefixCssAssetUrls(css, '/ops/queue')).toBe(
      'a{src:url(/ops/queue/assets/a.woff2)}' +
        'b{src:url("/ops/queue/assets/b.woff2")}c{src:url(data:x)}'
    );
    expect(prefixCssAssetUrls(css, '')).toBe(css);
  });

  test('scopes SPA fallback, assets, API proxy and agent bridge to the mount', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'bunqueue-base-path-'));
    const cssPath = join(scratch, 'app.css');
    const jsPath = join(scratch, 'app.js');
    writeFileSync(cssPath, 'a{src:url(/assets/font.woff2)}');
    writeFileSync(jsPath, 'export const ok = true;');
    const h = handler({
      basePath: '/internal/queue',
      assets: { '/assets/app.css': cssPath, '/assets/app.js': jsPath },
    });
    try {
      expect((await h(new Request('http://localhost:8080/'))).status).toBe(404);
      expect((await h(new Request('http://localhost:8080/internal/queue-next'))).status).toBe(404);
      expect(
        await (await h(new Request('http://localhost:8080/internal/queue/jobs/1'))).text()
      ).toBe('<html>ok</html>');

      const agent = await h(
        new Request('http://localhost:8080/internal/queue/agent/control/status?full=1')
      );
      expect((await agent.json()).url).toBe('http://agent.internal/control/status?full=1');

      const css = await h(new Request('http://localhost:8080/internal/queue/assets/app.css'));
      expect(css.headers.get('content-type')).toContain('text/css');
      expect(await css.text()).toContain('url(/internal/queue/assets/font.woff2)');
      const js = await h(new Request('http://localhost:8080/internal/queue/assets/app.js'));
      expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');

      let upstream = '';
      globalThis.fetch = ((input: RequestInfo | URL) => {
        upstream = String(input);
        return Promise.resolve(Response.json({ ok: true }));
      }) as typeof fetch;
      const api = await h(new Request('http://localhost:8080/internal/queue/api/queues?limit=2'));
      expect(api.status).toBe(200);
      expect(upstream).toBe('http://127.0.0.1:6790/queues?limit=2');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('uses runtime bases only after validation', () => {
    expect(resolveRouterBasename('/internal/queue/', '/build/')).toBe('/internal/queue');
    expect(resolveRouterBasename('//attacker.example', '/build/')).toBe('/build');
    expect(resolveDefaultBaseUrl('', '/internal/queue/api')).toBe('/internal/queue/api');
    expect(resolveDefaultBaseUrl('', '//attacker.example')).toBe('/api');
    expect(resolveDefaultBaseUrl('https://queue.example', '/internal/queue/api')).toBe(
      'https://queue.example'
    );
  });

  test('migrates only the legacy implicit /api default to the runtime mount', () => {
    expect(
      migratePersistedConnectionState(
        { baseUrl: '/api', refreshMs: 3_000 },
        2,
        '/internal/queue/api'
      )
    ).toMatchObject({
      profiles: [{ baseUrl: '/internal/queue/api' }],
      activeProfileId: 'default',
      refreshMs: 3_000,
    });
    expect(
      migratePersistedConnectionState(
        { baseUrl: 'https://queue.example/api', refreshMs: 3_000 },
        2,
        '/internal/queue/api'
      )
    ).toMatchObject({
      profiles: [{ baseUrl: 'https://queue.example/api' }],
      activeProfileId: 'default',
      refreshMs: 3_000,
    });
    expect(
      migratePersistedConnectionState(
        { baseUrl: '/api', refreshMs: 3_000 },
        3,
        '/internal/queue/api'
      )
    ).toMatchObject({
      profiles: [{ baseUrl: '/api' }],
      activeProfileId: 'default',
      refreshMs: 3_000,
    });
  });
});
