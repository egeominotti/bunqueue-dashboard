---
title: Quickstart
description: Get the bunqueue dashboard running in one command, then point it at a bunqueue server or let the control agent start one for you.
---

# Quickstart

Get the dashboard running in under a minute, then connect it to a bunqueue
server. Prefer to look before you install? Open the
[live demo](https://egeominotti.github.io/bunqueue-dashboard/), the full
dashboard running on sample data with no server needed.

## Prerequisites

- [Bun](https://bun.sh) 1.3 or newer.
- A bunqueue server to drive, or let the control agent start one for you (step 3).

## The one-liner: run from npm

No clone, no build, the
[`bunqueue-dashboard` npm package](https://www.npmjs.com/package/bunqueue-dashboard)
ships the prebuilt dashboard with **zero dependencies**:

```bash
bunx bunqueue-dashboard
```

Open **`http://127.0.0.1:8080`**. One process serves the UI, proxies `/api/*`
to your bunqueue server (`BUNQUEUE_URL`, default `http://localhost:6790`), and
runs the [control agent](/agent) on `127.0.0.1:6800` so the **Server** page can
start / stop / restart bunqueue for you.

Configure with env vars: `PORT` · `BIND_ADDR` · `BUNQUEUE_URL` · `AGENT_PORT` ·
`AGENT_ALLOWED_ORIGINS` · `AGENT_TOKEN` · `BUNQUEUE_START_CMD`. To install it
permanently instead of running via `bunx`:

```bash
bun add -g bunqueue-dashboard   # or: npm i -g bunqueue-dashboard (still runs on Bun)
bunqueue-dashboard
```

Then jump to [step 3](#_3-connect-a-server). Prefer to hack on it or run the
dev setup? Take the source route:

## From source

### 1. Install

```bash
git clone https://github.com/egeominotti/bunqueue-dashboard.git
cd bunqueue-dashboard
bun install
```

### 2. Run

```bash
bun start
```

One command boots the control agent and the dashboard together, and stops both
on `Ctrl-C`:

| Service | URL | Role |
| --- | --- | --- |
| Dashboard | `http://localhost:5273` | the UI (`/api` is proxied to `:6790`) |
| Control agent | `http://127.0.0.1:6800` | starts / stops / restarts the server process |

Open **`http://localhost:5273`**.

## 3. Connect a server

Two ways, pick either:

- **Let the agent start one.** Open **Control ▸ Server**, set the launch command,
  and press **Start**. The dashboard manages the process and tails its logs live.
  See [Server Control](/guide/server).
- **Point at an existing server.** Open **[Settings](/guide/settings)** and set the
  server URL (and a bearer token if it runs with `AUTH_TOKENS`), or bake it in at
  build time with `VITE_BUNQUEUE_URL`.

## Next steps

- Take the [illustrated tour of every screen](/user-guide).
- [Add your first job](/guide/add-job), then watch it in the
  [Jobs Explorer](/guide/jobs).
- Ship it: [Docker, Kubernetes, PM2, or a hosting platform](/deploy/).
- Press **Cmd / Ctrl-K** anywhere for the command palette.

::: tip Already have a server?
The dashboard never imports or modifies bunqueue, it only talks to its HTTP API,
so you can point it at any bunqueue server you already run.
:::
