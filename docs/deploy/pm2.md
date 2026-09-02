---
title: PM2
description: Run the all-in-one bunqueue dashboard server under PM2, with SPA, same-origin API proxy, and the control agent. Ecosystem file, env vars, and startup on boot.
---

# PM2

Use this when you run bunqueue on a box and want the dashboard to **also manage
the process** (start / stop / restart with live logs). PM2 keeps the
**all-in-one server** alive, restarts it on crash, and brings it back on reboot.

The all-in-one server (`scripts/serve.ts`) does three jobs in one process:

1. serves the dashboard SPA,
2. proxies `/api/*` to your bunqueue server **same-origin** (no CORS), and
3. runs the **control agent** on `127.0.0.1` for Server Control.

## Get the server

Pick one:

```bash
# A) Install from npm (needs Bun 1.4.0; dependencies are installed normally).
bun add -g bunqueue-dashboard        # then: bunqueue-dashboard
# one-off, no install:  bunx bunqueue-dashboard

# B) Download a standalone binary from the GitHub Releases (no runtime needed).
#    Assets: bunqueue-dashboard-<tag>-<os>-<arch>  (linux/macos x64+arm64, windows x64)
#    Replace <tag> with the latest release tag, e.g. v0.0.15:
curl -L -o bunqueue-dashboard \
  https://github.com/egeominotti/bunqueue-dashboard/releases/latest/download/bunqueue-dashboard-<tag>-linux-x64
chmod +x bunqueue-dashboard

# C) Build the binary yourself (needs Bun 1.4.0).
bun run build:bin      # → ./bunqueue-dashboard

# D) Run from source (needs Bun 1.4.0).
bun run scripts/serve.ts
```

## Configure it

All configuration is via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Port the dashboard + `/api` proxy listen on |
| `BIND_ADDR` | `127.0.0.1` | Interface the dashboard binds to; set `0.0.0.0` for direct LAN access (no reverse proxy) |
| `BUNQUEUE_URL` | `http://localhost:6790` | The bunqueue server to proxy to |
| `AGENT_PORT` | `6800` | Control agent port (always bound to `127.0.0.1`) |
| `AGENT_TOKEN` | _unset_ | Agent bearer token; required on every `/agent/*` request when LAN/proxy access is configured |
| `BUNQUEUE_TOKEN` | _unset_ | Admin-API bearer; required on every `/api/*` request when LAN/proxy access is configured |
| `AGENT_ALLOWED_ORIGINS` | dev + local origins | Exact external browser origins; their hostnames are also admitted by the Host gate |
| `AGENT_ALLOWED_HOSTS` | loopback names | Extra Host header names/IPs admitted on every dashboard route |
| `TRUST_PROXY` | _unset_ | Set `1` only when a trusted proxy overwrites `X-Forwarded-Host` because it rewrites `Host` |
| `LOG_LEVEL` | `info` | pino log level (`debug` / `info` / `warn` / `error`) |

::: tip Secure the agent
The direct agent port only binds `127.0.0.1`, but the all-in-one server also
bridges it at `/agent`. Any non-loopback bind, trusted-proxy mode, forwarding
header, or explicit non-loopback Host/origin switches that bridge to remote
policy: `AGENT_TOKEN` is then mandatory on **reads and writes**. Enter it when
the dashboard lock screen prompts; it stays in browser memory for that session.
The same remote policy disables `/api/*` unless `BUNQUEUE_TOKEN` is configured;
enter that value as the Server token in Settings. The two tokens are separate
credentials and should be rotated independently.
:::

## PM2 ecosystem file

Save as `ecosystem.config.cjs` next to the binary:

```js
module.exports = {
  apps: [
    {
      name: 'bunqueue-dashboard',
      script: './bunqueue-dashboard', // the compiled binary
      env: {
        PORT: 8080,
        BUNQUEUE_URL: 'http://localhost:6790',
        AGENT_TOKEN: 'change-me',
        BUNQUEUE_TOKEN: 'change-api-token',
        // Required for https://dashboard.example.com through a proxy that
        // preserves Host. Replace this with the exact external origin.
        AGENT_ALLOWED_ORIGINS: 'https://dashboard.example.com',
      },
      autorestart: true,
      max_restarts: 10,
    },
  ],
};
```

Running from source or from the npm global install instead of the binary? Use
Bun as the interpreter:

```js
// from source:      script: 'scripts/serve.ts', interpreter: 'bun',
// from npm global:  script: 'bunqueue-dashboard', interpreter: 'bun',
```

## Reverse proxy

Prefer preserving the external Host. This nginx shape needs no
`TRUST_PROXY`; `AGENT_ALLOWED_ORIGINS` in the PM2 example both admits the Host
and declares the exact browser origin:

```nginx
server {
  listen 443 ssl;
  server_name dashboard.example.com;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

If the proxy must rewrite `Host`, its replacement Host must also be loopback or
listed in `AGENT_ALLOWED_HOSTS`. It must **overwrite** `X-Forwarded-Host` with
the external authority; then opt in to trusting that value:

```nginx
proxy_set_header Host 127.0.0.1:8080;
proxy_set_header X-Forwarded-Host $http_host;
```

```js
TRUST_PROXY: '1',
AGENT_ALLOWED_ORIGINS: 'https://dashboard.example.com',
AGENT_TOKEN: 'change-me',
BUNQUEUE_TOKEN: 'change-api-token',
```

Never pass through a client-supplied `X-Forwarded-Host` when `TRUST_PROXY=1`.
The Host allowlist is still evaluated against the rewritten raw `Host` before
the forwarded value is considered.

::: warning Protect the API proxy too
`/api/*` forwards Bunqueue's administrative HTTP API. A LAN/proxied all-in-one
server fails closed until `BUNQUEUE_TOKEN` is set, and then requires that bearer
on every request. Enter the same value in Settings. If Bunqueue itself enables
`AUTH_TOKENS`, make it one of those tokens because Authorization is forwarded
upstream. Host and Origin checks remain CSRF/rebinding defenses, not auth.
:::

## Direct LAN access

A wildcard bind cannot infer which LAN IP or alias clients will put in `Host`.
List every reachable origin (or list bare names/IPs in `AGENT_ALLOWED_HOSTS`),
and configure the mandatory agent token:

```js
BIND_ADDR: '0.0.0.0',
AGENT_ALLOWED_ORIGINS: 'http://192.168.1.50:8080,http://dashboard.lan:8080',
AGENT_TOKEN: 'change-me',
BUNQUEUE_TOKEN: 'change-api-token',
```

Without that allowlist, `/`, assets, `/api` and `/agent` all fail closed with
`403 Host not allowed`. A fixed `BIND_ADDR=192.168.1.50` admits that concrete
address automatically, but aliases still need to be listed.

## Start, persist, boot

```bash
pm2 start ecosystem.config.cjs
pm2 save          # remember the process list
pm2 startup       # print the command to start PM2 on boot, then run it
```

Useful day-to-day:

```bash
pm2 logs bunqueue-dashboard     # tail logs
pm2 restart bunqueue-dashboard  # after a config change
pm2 status                      # health at a glance
```

Open `http://localhost:8080` (or your reverse-proxied domain). Because `/api`
is proxied same-origin, there is no CORS to configure, and **Server Control**
works because the control agent runs in the same process. On LAN/proxy access,
the first agent request prompts for `AGENT_TOKEN`; the credential is kept only
in memory and must be re-entered after a reload. Enter `BUNQUEUE_TOKEN` in the
Server-token prompt/Settings for `/api`; it is also held only in browser memory.

## Prefer systemd?

The binary is a plain executable, so a unit works just as well:

```ini
[Unit]
Description=bunqueue dashboard
After=network.target

[Service]
ExecStart=/opt/bunqueue-dashboard/bunqueue-dashboard
Environment=PORT=8080
Environment=BUNQUEUE_URL=http://localhost:6790
Environment=AGENT_TOKEN=change-me
Environment=BUNQUEUE_TOKEN=change-api-token
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
