# Control agent

## Why it exists

A browser cannot start or stop an OS process, and bunqueue's HTTP API has no
process-lifecycle endpoint (and we don't modify bunqueue). So the dashboard ships
a tiny **local agent** — a Bun process that supervises a bunqueue server child —
and drives it over HTTP.

## Files

- `agent/manager.ts` — `ProcessManager`: `start()`, `stop()`, `restart()`,
  `getStatus()`, `getLogs()`, `getConfig()`, `setConfig()`, `dbStats()`. Spawns the
  configured command with `Bun.spawn`, pipes stdout/stderr into a bounded log ring
  buffer, and on `stop()` sends SIGTERM then SIGKILL after an 8s timeout. Tracks
  `runningConfig` — the config the live process was launched with — separately from
  the editable `config`, so editing ports/data-path while running does not confuse
  the health probe. Every process generation carries a monotonic **process token**;
  `onExit`/`stop()` only mutate shared state when their token is still current, so a
  `stop()` awaiting an old process can't clobber one a concurrent `start()` brought
  up. `dbStats()` stats the configured SQLite file plus its `-wal`/`-shm` sidecars.
- `agent/server.ts` — request handling + **auth/Origin policy**, factored out so it
  is unit-testable without binding a port (`createFetchHandler(mgr, opts)`,
  `resolveAllowedOrigins`, `isOriginAllowed`, `corsHeaders`).
- `agent/index.ts` — thin `Bun.serve` wrapper. **Binds `127.0.0.1` only** and
  applies the security policy below.

## Security

The agent can spawn arbitrary processes (`PUT /control/config` sets the launch
command; `POST /control/start` runs it), so binding loopback is not enough — a
malicious web page the user is visiting could otherwise issue a cross-origin
request to `http://127.0.0.1:6800` (CSRF → RCE). Defenses:

1. **Locked CORS** — the `Access-Control-Allow-Origin` header is reflected only
   for an allowed origin, **never `*`**. A disallowed origin gets no ACAO, so the
   browser blocks it.
2. **Origin allowlist** — any request carrying a disallowed `Origin` header is
   rejected `403` before it reaches the `ProcessManager`. A cross-origin browser
   request always sends `Origin`, so a drive-by page cannot start/stop/reconfigure
   the server. Non-browser callers (curl, same process) send no `Origin` and keep
   working for local use.
3. **Optional bearer token** — set `AGENT_TOKEN` to require it on state-changing
   requests (`Authorization: Bearer <t>` or `x-agent-token: <t>`).

Env: `AGENT_ALLOWED_ORIGINS` (comma-separated; merged with dev defaults
`http://localhost:5273`, `http://127.0.0.1:5273`) and `AGENT_TOKEN`.

## Endpoints (`http://127.0.0.1:6800`)

| Method · Path | Action |
| --- | --- |
| `GET /control/status` | `{ status, pid, startedAt, exitCode, healthy, version, config, runningConfig, db }` (probes the managed server's `/health` on `runningConfig.httpPort`; `db` = on-disk SQLite size) |
| `POST /control/start` | Spawn the server, return status |
| `POST /control/stop` | SIGTERM → SIGKILL, return status |
| `POST /control/restart` | Stop then start |
| `GET /control/logs` | `{ lines: [{ seq, ts, stream, line }] }` |
| `GET /control/config` | current `ServerConfig` |
| `PUT /control/config` | update config (allowed anytime; ports/data-path apply on next start/restart) |

`db` = `{ path, exists, size, walSize, shmSize, totalSize, mtimeMs }` — bytes on
disk for the SQLite main file plus its WAL/SHM sidecars.

## Configuration

`ServerConfig` = `{ command, httpPort, tcpPort, dataPath, extraEnv }`. The agent
launches `command` (default `bunqueue start`, e.g. `bun run ../src/main.ts` when
developing) with `HTTP_PORT`, `TCP_PORT`, `BUNQUEUE_DATA_PATH` and `extraEnv`
injected into the environment. Config is **editable at any time**; a running
process keeps its launch config (`runningConfig`) and picks up port/data-path
changes on the next start/restart. Defaults come from env: `AGENT_PORT`,
`BUNQUEUE_START_CMD`, `HTTP_PORT`, `TCP_PORT`, `BUNQUEUE_DATA_PATH`.

## In the dashboard

`Control ▸ Server` (`pages/control/ServerControl.tsx`) polls `bq.control.status()`
and `bq.control.logs()`, shows status / health / pid / uptime, a **storage row**
(SQLite db / WAL / total on-disk / last-modified from `status.db`), exposes Start /
Stop / Restart, an **always-editable config form** (with a `Save & restart`
shortcut and a "Restart to apply changes" hint when the live config differs), and
a live, colour-coded process-log tail. If the agent is unreachable it shows how to
start it (`bun run agent/index.ts`).

## Tested

`test/manager.test.ts` starts and stops a real child process (`sleep`), asserts
running/stopped transitions and pid, verifies config **can be edited while running**
(and that the change only applies on restart, leaving `runningConfig` intact),
checks `dbStats()` reports on-disk sizes (and reports a missing db as empty),
checks stdout + system log capture (`echo`), and proves the **concurrent
stop-then-start race** no longer orphans the newly-started process.

`test/agent-server.test.ts` covers the security policy against synthetic requests
(no port bound): the Origin allowlist / no-wildcard CORS, a cross-origin
`PUT /control/config` rejected `403` **without** mutating the launch command
(the CSRF-to-RCE vector), same-origin + non-browser requests succeeding, OPTIONS
preflight ACAO, and the optional `AGENT_TOKEN` gate on mutations.
