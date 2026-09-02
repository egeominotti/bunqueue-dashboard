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

- [Bun](https://bun.sh) 1.4.0, pinned by the repository, CI and published package.
- A bunqueue server to drive, or let the control agent start one for you (step 3).

## The one-liner: run from npm

No clone, no build, the
[`bunqueue-dashboard` npm package](https://www.npmjs.com/package/bunqueue-dashboard)
ships the prebuilt dashboard and installs the exact compatible Bunqueue client:

```bash
bunx bunqueue-dashboard
```

Open **`http://127.0.0.1:8080`**. One process serves the UI, proxies `/api/*`
to your bunqueue server (`BUNQUEUE_URL`, default `http://localhost:6790`), and
runs the [control agent](/agent) on `127.0.0.1:6800` so the **Server** page can
start / stop / restart bunqueue for you.

Configure with env vars: `PORT` · `BIND_ADDR` · `BUNQUEUE_URL` · `AGENT_PORT` ·
`AGENT_ALLOWED_ORIGINS` · `AGENT_ALLOWED_HOSTS` · `AGENT_TOKEN` · `BUNQUEUE_TOKEN` ·
`TRUST_PROXY` · `BASE_PATH` · `BUNQUEUE_MANAGED` · `BUNQUEUE_START_CMD`. LAN and
reverse-proxy deployments require an explicit Host/origin allowlist plus
`AGENT_TOKEN` for `/agent` and `BUNQUEUE_TOKEN` for `/api`; see
[PM2 deployment](/deploy/pm2).
To install it permanently instead of running via `bunx`:

```bash
bun add -g bunqueue-dashboard
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
- **Point at existing servers.** Open **[Settings](/guide/settings)** and add one
  profile per Bunqueue API + paired agent (with their separate tokens), or seed
  the first server URL at build time with `VITE_BUNQUEUE_URL`. For multiple
  PostgreSQL-backed brokers, verify and operate them from [Fleet](/guide/fleet).

When the all-in-one dashboard connects to a broker owned by systemd, Docker or
Kubernetes, launch it with `BUNQUEUE_MANAGED=0 BUNQUEUE_URL=http://127.0.0.1:6790`.
The Server page becomes an attach-only health view and all child-process controls
are removed. Backup restore also fails closed because only the external supervisor
can prove that the broker has released its database.

## Next steps

- Take the [illustrated tour of every screen](/user-guide).
- [Add your first job](/guide/add-job), then watch it in the
  [Jobs Explorer](/guide/jobs).
- Ship it: [Docker, Kubernetes, PM2, or a hosting platform](/deploy/).
- Press **Cmd / Ctrl-K** anywhere for the command palette.

::: tip Already have a server?
The dashboard never modifies Bunqueue. Most screens use its HTTP API; Flow,
Workflow and backup operations go through the loopback agent using the pinned
public Bunqueue client/CLI, so point the agent at the same server and data path.
:::
