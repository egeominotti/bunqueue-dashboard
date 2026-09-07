---
title: Deployment
description: Deploy the bunqueue dashboard as a static site or a single all-in-one server, with Docker, Kubernetes, PM2, or a hosting platform. Two modes, one decision.
---

# Deployment

The dashboard is a **static single-page app**. That makes it cheap and easy to
host: build it once, serve the files anywhere. The only real decision is **how
the browser reaches your bunqueue server**, and that gives you two modes.

## Two modes

### 1. Static site (recommended for most)

Build the SPA and serve the `dist/` folder from any static host or the Docker
image (Caddy). There is **no backend** in this mode, the browser talks to your
bunqueue server directly.

Good for: Vercel, Netlify, Cloudflare Pages, GitHub Pages, S3, the Docker image
behind your own proxy, Kubernetes.

### 2. All-in-one server (SPA + API proxy + control agent)

One process (`scripts/serve.ts`) that serves the SPA, proxies `/api/*` to your
bunqueue server **same-origin** (no CORS), and runs the **control agent** so
you can start / stop / restart the bunqueue process from the UI. Three ways to
get it:

```bash
bunx bunqueue-dashboard   # from npm, installs dependencies, needs Bun 1.4.2
```

or download a **standalone binary** from the
[GitHub Releases](https://github.com/egeominotti/bunqueue-dashboard/releases)
(no runtime needed at all), or run it from a source checkout.

Good for: a VM or box where you run bunqueue itself and want full process
control. Run it under **[PM2](/deploy/pm2)**, systemd, or Docker.

::: tip Which one?
If you just want to **view and drive an existing** bunqueue server, use the
**static site**. If you want the dashboard to also **manage the server
process** (start / stop / restart with live logs), use the **all-in-one
server**, the control agent only exists there.
:::

## How the dashboard finds your server

Every request goes to a **base URL**, resolved in this order:

1. `VITE_BUNQUEUE_URL` baked in at **build time**, else
2. `/api` (a same-origin path that something must proxy), and
3. whatever you type on the in-app **[Settings](/guide/settings)** page wins at
   runtime (it is saved in the browser).

So you have two wiring strategies:

| Strategy | How | Trade-off |
| --- | --- | --- |
| **Direct (cross-origin)** | Set `VITE_BUNQUEUE_URL` to the server's public origin, e.g. `https://queue.example.com` | Simplest to deploy. The bunqueue server must allow the dashboard's origin (CORS). |
| **Same-origin proxy** | Serve the dashboard and forward `/api/*` to bunqueue from the same host | No CORS. The **all-in-one server** does this automatically; with the Caddy image, add a `reverse_proxy` (see [Docker](/deploy/docker#same-origin-api-proxy)). |

If the bunqueue server needs a bearer token (`AUTH_TOKENS`), enter it in
Settings for the current browser session or authenticate at the front proxy.
Never bake a secret into `VITE_*`; build-time values are public bundle text.

For a LAN/reverse-proxied **all-in-one server**, also configure
`BUNQUEUE_TOKEN`: `/api/*` otherwise returns `403`, and every request must carry
that bearer. Enter the same value as the Server token in Settings. If Bunqueue
uses `AUTH_TOKENS`, configure that value upstream too because Authorization is
forwarded. This gate belongs to the all-in-one server; static hosting still
depends on Bunqueue or the front proxy for authentication.

### Existing externally supervised server

The all-in-one process normally owns the Bunqueue child lifecycle. If systemd,
Docker or Kubernetes already owns that process, make the relationship explicit:

```bash
BUNQUEUE_MANAGED=0 \
BUNQUEUE_URL=http://127.0.0.1:6790 \
BUNQUEUE_TOKEN="$SERVER_TOKEN" \
bunx bunqueue-dashboard
```

In this attach-only mode, **Control ▸ Server** probes `BUNQUEUE_URL/health`,
labels the server **External**, and exposes no Start, Stop, Restart or launch
configuration controls. The agent rejects those lifecycle/config mutations with
HTTP 409 as a second line of defense. Stopped-only backup restore receives the
same fail-closed response because external process state cannot be proven.

### All-in-one server below a URL prefix

`BASE_PATH` is the runtime equivalent of a static build's `VITE_BASE`. It moves
the SPA router, embedded assets, same-origin API proxy and agent bridge together:

```bash
BASE_PATH=/internal/queue bunx bunqueue-dashboard
```

Preserve the prefix when forwarding to the all-in-one listener:

```nginx
location /internal/queue/ {
  proxy_pass http://127.0.0.1:8080;
}
```

The browser then uses `/internal/queue/assets/*`, `/internal/queue/api/*` and
`/internal/queue/agent/*`; deep-link refreshes stay inside the mount. Requests
outside the configured mount return 404. `BASE_PATH` accepts a leading-slash,
URL-safe path and normalizes its trailing slash. Target-pinned Flow, Workflow,
Queue and Backup requests accept only that exact prefixed API alias and still
resolve it through the local anti-SSRF check.

## Pick your target

| You want to | Go to |
| --- | --- |
| Run a container | [Docker](/deploy/docker) |
| Deploy to a cluster | [Kubernetes](/deploy/kubernetes) |
| Keep a long-running process alive on a box | [PM2](/deploy/pm2) |
| Push to Vercel / Netlify / Cloudflare / Fly / Render / Cloud Run | [Hosting platforms](/deploy/platforms) |

## Build output, in one place

```bash
bun install
bun run build        # → dist/  (static SPA: index.html + assets/)
```

- Deploying under a **sub-path** (e.g. `example.com/dashboard/`)? Build with
  `VITE_BASE=/dashboard/ bun run build`.
- Baking in the server origin? `VITE_BUNQUEUE_URL=https://queue.example.com bun run build`.
- The static SPA needs a **history-API fallback**: every unknown path must
  return `index.html`, or deep links and refreshes 404. Each platform page
  below shows how.
