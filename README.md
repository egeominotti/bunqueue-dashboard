# bunqueue dashboard

A web dashboard to **completely drive** a [bunqueue](https://bunqueue.dev) server —
monitor and control queues, jobs, DLQ, cron, webhooks, workers, a live activity
stream, and the server **process lifecycle** (start / stop / restart).

Built with **React 19 · React Router 7 · Zustand 5 · Vite 8 · Tailwind CSS v4 ·
Biome · Bun · TypeScript**. It talks to bunqueue's HTTP API (`:6790`) and a small
local **control agent** — it never modifies bunqueue itself.

![sections: Overview · Queues · Jobs · DLQ · Cron · Metrics · Workers · Logs · Control (Server, Add Job, Job Inspector, Queue Control, Cron Manager, DLQ, Webhooks, Diagnostics)](docs/README.md)

## Quick start

```bash
cd dashboard
bun install

# 1) A bunqueue server (or start it later from the Server page)
bun run ../src/main.ts            # HTTP :6790, TCP :6789

# 2) The control agent — enables Start/Stop/Restart from the dashboard
bun run agent/index.ts            # http://127.0.0.1:6800

# 3) The dashboard
bun dev                           # http://localhost:5273
```

In dev, `/api/*` is proxied to `http://localhost:6790` (see `vite.config.ts`), so
there is no CORS setup for local use. The control agent is called directly at
`http://localhost:6800` (CORS-enabled, localhost-only).

## What it can do

| Area | Page | Capability |
| --- | --- | --- |
| Home | Overview | Live health banner, throughput, queue health, recent activity |
| Server | **Control ▸ Server** | **Start / stop / restart** the server, edit its config, tail process logs |
| Jobs | Control ▸ Add Job | Enqueue jobs (single or bulk) with every option |
| Jobs | Control ▸ Job Inspector | Look up any job; promote / retry / discard / cancel / re-prioritize / delay / view data & result |
| Queues | Control ▸ Queue Control | Pause / resume / drain / clean / promote / retry-completed, rate-limit, concurrency, stall & DLQ policy |
| Cron | Control ▸ Cron Manager | Create (cron or interval) and delete schedules |
| DLQ | Control ▸ DLQ | Inspect entries, retry one/all, purge |
| Webhooks | Control ▸ Webhooks | Create / enable / delete job-event webhooks |
| Ops | Control ▸ Diagnostics | Health, ping, storage, memory, connections, totals |
| View | Queues / Jobs / DLQ / Cron / Metrics / Workers / Logs | Read-only browsing + basic actions |

## Configuration

| Env var | Purpose | Default |
| --- | --- | --- |
| `VITE_BUNQUEUE_URL` | bunqueue server origin | `/api` (dev proxy → `:6790`) |
| `VITE_BUNQUEUE_TOKEN` | Bearer token if `AUTH_TOKENS` is set | – |
| `VITE_BUNQUEUE_AGENT_URL` | Control agent origin | `http://localhost:6800` |

You can also change the server URL, token and refresh interval at runtime under
**Settings**.

## Scripts

```bash
bun dev            # dev server
bun run agent/index.ts  # control agent (process lifecycle)
bun run build      # typecheck + production build → dist/
bun run preview    # preview the production build
bun run check      # Biome lint + format
bun test           # unit + agent lifecycle tests
```

## How it works

See [`docs/`](docs/README.md): architecture, page-by-page behaviour, the control
agent, the API mapping (with verified response-shape gotchas), and the
development workflow.

> Alerts are stored locally in the browser (bunqueue OSS has no alerting
> backend); everything else reads and writes live to the server.
# bunqueue-dashboard
# bunqueue-dashboard
