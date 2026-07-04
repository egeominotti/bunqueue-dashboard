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
bunx bunqueue-dashboard   # from npm, zero dependencies, needs Bun
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

If the bunqueue server itself needs a bearer token (`AUTH_TOKENS`), set
`VITE_BUNQUEUE_TOKEN` at build time, or paste it into Settings.

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
