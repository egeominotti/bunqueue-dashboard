/**
 * Installs the no-network demo backend. The module remains lazy-loaded so its
 * fixture data does not enter the normal dashboard bundle.
 */
import { API_ROOTS, demoApiResponse } from './api';
import { dbExportResponse } from './databaseView';
import { createDemoQueueOperations } from './queueOperations';
import { jsonResponse, sseResponse } from './responses';

let installed = false;

export function installDemo(): () => void {
  if (installed || typeof window === 'undefined') return () => undefined;
  installed = true;
  const previousFetch = window.fetch;
  const realFetch = previousFetch.bind(window);
  const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
  const queueOperations = createDemoQueueOperations();

  const demoFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const rawUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (request?.url ?? '');
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();

    let url: URL;
    try {
      url = new URL(rawUrl, window.location.origin);
    } catch {
      return realFetch(input, init);
    }

    let path = url.pathname;
    if (base && (path === base || path.startsWith(`${base}/`))) {
      path = path.slice(base.length) || '/';
    }
    if (path === '/api' || path.startsWith('/api/')) path = path.slice(4) || '/';

    const root = path.split('/').filter(Boolean)[0];
    if (!root || !API_ROOTS.has(root)) return realFetch(input, init);
    if (root === 'queue-operations') {
      try {
        const operationRequest =
          input instanceof Request ? new Request(input, init) : new Request(url, init);
        return await queueOperations(operationRequest, path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResponse(
          { ok: false, error: `Invalid Queue operation request: ${message}` },
          400
        );
      }
    }
    if (root === 'events') {
      return sseResponse(init?.signal ?? request?.signal);
    }
    if (root === 'healthz' || root === 'live') {
      return new Response('OK', { status: 200 });
    }
    if (method === 'GET') {
      const segments = path.replace(/\/+$/, '').split('/').filter(Boolean);
      if (
        segments.length === 4 &&
        segments[0] === 'db' &&
        segments[1] === 'tables' &&
        segments[3] === 'export'
      ) {
        return dbExportResponse(decodeURIComponent(segments[2]), url.search);
      }
    }
    return jsonResponse(demoApiResponse(path, method, url.search));
  };
  window.fetch = demoFetch as typeof window.fetch;

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    if (window.fetch === demoFetch) window.fetch = previousFetch;
    installed = false;
  };
}
