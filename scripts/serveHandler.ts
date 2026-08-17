import { isHostAllowed, isOriginAllowed } from '../agent/server';
import { safeErrorMessage } from '../agent/errorMessage';
import {
  agentSubUrl,
  apiTokenOk,
  isRemoteBridgeRequest,
  prefixCssAssetUrls,
  stripBasePath,
  type ServeHandlerOptions,
  withSecurityHeaders,
} from './servePolicy';

const ASSET_CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function assetContentType(pathname: string): string | undefined {
  const dot = pathname.lastIndexOf('.');
  return dot === -1 ? undefined : ASSET_CONTENT_TYPES[pathname.slice(dot).toLowerCase()];
}

/** Static assets, the admin proxy, and the same-origin agent bridge. */
export function createServeHandler(opts: ServeHandlerOptions) {
  const {
    api,
    indexHtml,
    assets,
    agentHandle,
    remoteAgentHandle,
    allowedOrigins,
    allowedHosts,
    agentBridge,
    agentTokenConfigured,
    apiToken,
    apiShutdownSignal,
    remoteBridgePolicy = false,
    trustProxy = false,
    basePath = '',
  } = opts;
  const secure = withSecurityHeaders;
  const rewrittenCss = new Map<string, Promise<string>>();
  const indexResponse = () =>
    new Response(indexHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (!isHostAllowed(req.headers.get('host'), allowedHosts)) {
      return secure(new Response('Host not allowed', { status: 403 }));
    }
    const pathname = stripBasePath(url.pathname, basePath);
    if (pathname === null) return secure(new Response('Not found', { status: 404 }));

    const origin = req.headers.get('origin');
    let originHost = '';
    try {
      originHost = origin ? new URL(origin).host.toLowerCase() : '';
    } catch {
      originHost = '';
    }
    // Forwarded hosts are only trustworthy when an operator declares the proxy boundary.
    const fwd = trustProxy ? req.headers.get('x-forwarded-host')?.split(',') : undefined;
    const forwardedHost = fwd?.[fwd.length - 1]?.trim().toLowerCase();
    const sameOrigin =
      originHost !== '' &&
      (originHost === url.host.toLowerCase() || originHost === forwardedHost);

    if (pathname === '/agent' || pathname.startsWith('/agent/')) {
      const remoteRequest = isRemoteBridgeRequest(req, remoteBridgePolicy);
      if (!agentBridge || (remoteRequest && !agentTokenConfigured)) {
        return secure(
          Response.json(
            {
              ok: false,
              error:
                'Control agent disabled for remote or proxied access. Set AGENT_TOKEN to expose it.',
            },
            { status: 403 }
          )
        );
      }
      const sub = agentSubUrl(pathname, url.search);
      const headers = new Headers(req.headers);
      if (sameOrigin && origin && !isOriginAllowed(origin, allowedOrigins)) headers.delete('origin');
      const handleAgent = remoteRequest ? remoteAgentHandle : agentHandle;
      return secure(
        await handleAgent(
          new Request(sub.href, {
            method: req.method,
            headers,
            body: req.body,
            signal: req.signal,
          })
        )
      );
    }

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      if (!sameOrigin && !isOriginAllowed(origin, allowedOrigins)) {
        return secure(
          Response.json({ ok: false, error: 'Origin not allowed' }, { status: 403 })
        );
      }
      if (isRemoteBridgeRequest(req, remoteBridgePolicy)) {
        if (!apiToken) {
          return secure(
            Response.json(
              {
                ok: false,
                error:
                  'Admin API proxy disabled for remote or proxied access. Set BUNQUEUE_TOKEN to expose it.',
              },
              { status: 403 }
            )
          );
        }
        if (!apiTokenOk(req, apiToken)) {
          return secure(
            Response.json(
              { ok: false, error: 'A valid BUNQUEUE_TOKEN bearer token is required.' },
              { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }
            )
          );
        }
      }
      const target = api + (pathname.slice(4) || '/') + url.search;
      let res: Response;
      const signal = apiShutdownSignal
        ? AbortSignal.any([req.signal, apiShutdownSignal])
        : req.signal;
      try {
        res = await fetch(target, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          redirect: 'manual',
          signal,
        });
      } catch (err) {
        return secure(
          Response.json(
            { ok: false, error: `bunqueue unreachable at ${api}: ${safeErrorMessage(err)}` },
            { status: 502 }
          )
        );
      }
      // Bun decompresses fetch bodies but can retain the upstream encoding headers.
      const headers = new Headers(res.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      headers.delete('transfer-encoding');
      return secure(
        new Response(ownedProxyBody(res.body, signal), {
          status: res.status,
          statusText: res.statusText,
          headers,
        })
      );
    }

    const key = pathname === '/' ? '/index.html' : pathname;
    if (key === '/index.html') return secure(indexResponse());
    const asset = assets[key];
    if (asset) {
      if (basePath && key.endsWith('.css')) {
        let css = rewrittenCss.get(asset);
        if (!css) {
          css = Bun.file(asset)
            .text()
            .then((contents) => prefixCssAssetUrls(contents, basePath));
          rewrittenCss.set(asset, css);
        }
        return secure(
          new Response(await css, { headers: { 'content-type': 'text/css; charset=utf-8' } })
        );
      }
      const contentType = assetContentType(key);
      return secure(
        new Response(Bun.file(asset), {
          headers: contentType ? { 'content-type': contentType } : undefined,
        })
      );
    }
    if (pathname.startsWith('/assets/')) {
      return secure(new Response('Not found', { status: 404 }));
    }
    return secure(indexResponse());
  };
}

/** Own a proxied response after fetch headers settle so shutdown also ends its body. */
export function ownedProxyBody(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let terminal = false;

  const detach = () => signal.removeEventListener('abort', abort);
  const cancelReader = async (reason: unknown) => {
    try {
      await reader.cancel(reason);
    } catch {
      // Cancellation is best-effort; the owned outbound stream still terminates.
    }
  };
  const abort = () => {
    if (terminal) return;
    terminal = true;
    detach();
    try {
      controller?.close();
    } catch {
      // A concurrent consumer cancellation may already have closed the stream.
    }
    void cancelReader(signal.reason);
  };

  return new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    },
    async pull(nextController) {
      try {
        const chunk = await reader.read();
        if (terminal) return;
        if (chunk.done) {
          terminal = true;
          detach();
          nextController.close();
        } else {
          nextController.enqueue(chunk.value);
        }
      } catch (error) {
        if (terminal) return;
        terminal = true;
        detach();
        nextController.error(error);
      }
    },
    async cancel(reason) {
      if (terminal) return;
      terminal = true;
      detach();
      await cancelReader(reason);
    },
  });
}
