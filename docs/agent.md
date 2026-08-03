---
title: Control agent
description: "The local control agent that starts, stops, and restarts the bunqueue process: its endpoints, security model, and read-only SQLite inspector."
---

# Control agent

## Why it exists

A browser cannot start or stop an OS process, and bunqueue's HTTP API has no
process-lifecycle endpoint (and we don't modify bunqueue). So the dashboard ships
a tiny **local agent**, a Bun process that supervises a bunqueue server child, and drives it over HTTP.

## Files

- `agent/manager.ts`, `ProcessManager`: `start()`, `stop()`, `restart()`, `getStatus()`, `getLogs()`, `getConfig()`, `setConfig()`, `dbStats()`. Spawns the
  configured command with `Bun.spawn`, pipes stdout/stderr into a bounded log ring
  buffer, and on `stop()` sends SIGTERM then SIGKILL after an 8s timeout. Tracks
  `runningConfig`, the config the live process was launched with, separately from
  the editable `config`, so editing ports/data-path while running does not confuse
  the health probe. Every process generation carries a monotonic **process token**;
  `onExit`/`stop()` only mutate shared state when their token is still current, so a
  `stop()` awaiting an old process can't clobber one a concurrent `start()` brought
  up. `dbStats()` stats the configured SQLite file plus its `-wal`/`-shm` sidecars.
- `agent/server.ts`, request handling + **auth/Origin policy**, factored out so it
  is unit-testable without binding a port (`createFetchHandler(mgr, opts)`, `resolveAllowedOrigins`, `isOriginAllowed`, `corsHeaders`).
- `agent/index.ts`, thin `Bun.serve` wrapper. **Binds `127.0.0.1` only** and
  applies the security policy below.

## Security

The agent can spawn arbitrary processes (`PUT /control/config` sets the launch
command; `POST /control/start` runs it), so binding loopback is not enough, a
malicious web page the user is visiting could otherwise issue a cross-origin
request to `http://127.0.0.1:6800` (CSRF → RCE). Defenses:

1. **Locked CORS**, the `Access-Control-Allow-Origin` header is reflected only
   for an allowed origin, **never `*`**. A disallowed origin gets no ACAO, so the
   browser blocks it.
2. **Origin allowlist**, any request carrying a disallowed `Origin` header is
   rejected `403` before it reaches the `ProcessManager`. A cross-origin browser
   request always sends `Origin`, so a drive-by page cannot start/stop/reconfigure
   the server. Non-browser callers (curl, same process) send no `Origin` and keep
   working for local use.
3. **Host allowlist (DNS-rebinding defense)**, the Origin gate can't see a
   *same-origin* request (a page whose DNS was rebound to `127.0.0.1` sends no
   `Origin`), so the agent also rejects `403` any request whose `Host` header is
   a hostname outside the allowlist, so an attacker domain rebound to loopback
   fails it, while `Host: localhost` / `127.0.0.1` pass. A missing `Host` (a
   non-browser caller) is rejected once the allowlist is enabled. Host and
   Origin are validated before an `OPTIONS` preflight receives `204`.
4. **Scoped bearer token**, on loopback `AGENT_TOKEN` protects state-changing
   requests (`Authorization: Bearer <t>` or `x-agent-token: <t>`) while local
   reads remain zero-configuration. A LAN or reverse-proxied all-in-one bridge
   requires the token and applies it to **every** agent route, including status,
   logs, config, and database reads. Enter the token under **Settings → Agent
   token** or in the authentication prompt; it remains in browser memory for
   the current session. Never put it in a `VITE_*` value, which is public bundle
   plaintext.

Env: `AGENT_ALLOWED_ORIGINS` (comma-separated; merged with dev defaults
`http://localhost:5273`, `http://127.0.0.1:5273`), `AGENT_ALLOWED_HOSTS` and
`AGENT_TOKEN`; the all-in-one server also reads `TRUST_PROXY` and the separate
`BUNQUEUE_TOKEN`, which gates every remote/proxied `/api/*` request.

> **Reverse proxy / custom hostname on a loopback bind.** The Host allowlist is
> loopback names plus `AGENT_ALLOWED_HOSTS`; the all-in-one binary also includes
> hostnames from `AGENT_ALLOWED_ORIGINS`. A proxy that preserves public `Host`
> must list it in either variable. A Host-rewriting proxy must list its raw
> replacement Host, overwrite `X-Forwarded-Host` with the external authority,
> and set `TRUST_PROXY=1`. Any such non-loopback configuration switches the
> `/agent` bridge to all-route token authentication and disables it with `403`
> if `AGENT_TOKEN` is missing. Merely binding the socket to loopback does not
> make a public proxy local.

> **The `/api` credential is separate.** Remote/proxied all-in-one deployments
> also fail `/api/*` closed without `BUNQUEUE_TOKEN`; when configured, every API
> request must carry it as a bearer. Enter that value as the Server token in
> Settings. If Bunqueue enables `AUTH_TOKENS`, the same value must be accepted
> upstream because the Authorization header is forwarded unchanged.

> The plain `bun run agent` (`agent/index.ts`) direct listener intentionally
> remains a zero-config loopback tool. Do **not** publish port `6800` through a
> reverse proxy; use the all-in-one `/agent` bridge or put independent
> authentication in front of it. Only the all-in-one binary reads `BIND_ADDR`.
> For `0.0.0.0`, list every public/LAN name or IP in `AGENT_ALLOWED_HOSTS` (or
> its full origin in `AGENT_ALLOWED_ORIGINS`); wildcard binds cannot infer them.

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

`db` = `{ path, exists, size, walSize, shmSize, totalSize, mtimeMs }`, bytes on
disk for the SQLite main file plus its WAL/SHM sidecars.

## Configuration

`ServerConfig` = `{ command, httpPort, tcpPort, dataPath, extraEnv }`. Updates
are validated atomically: unknown keys, an empty/non-string command, invalid
ports, a non-string data path, or a non-string environment map return HTTP 400
without partially changing the previous configuration. The agent
launches `command` (default `bunqueue start`, e.g. `bun run ../src/main.ts` when
developing) with `HTTP_PORT`, `TCP_PORT`, `BUNQUEUE_DATA_PATH` and `extraEnv`
injected into the environment. Config is **editable at any time**; a running
process keeps its launch config (`runningConfig`) and picks up port/data-path
changes on the next start/restart. Defaults come from env: `AGENT_PORT`, `BUNQUEUE_START_CMD`, `HTTP_PORT`, `TCP_PORT`, `BUNQUEUE_DATA_PATH`.

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
(and that the change only applies on restart, leaving `runningConfig` intact), checks `dbStats()` reports on-disk sizes (and reports a missing db as empty), checks stdout + system log capture (`echo`), and proves the **concurrent
stop-then-start race** no longer orphans the newly-started process.

`test/agent-server.test.ts` covers the security policy against synthetic requests
(no port bound): the Origin allowlist / no-wildcard CORS, a cross-origin
`PUT /control/config` rejected `403` **without** mutating the launch command
(the CSRF-to-RCE vector), same-origin + non-browser requests succeeding, OPTIONS
preflight ACAO, loopback mutation auth, and all-route auth for network exposure.
