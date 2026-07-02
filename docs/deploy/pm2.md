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
# A) Download a standalone binary from the GitHub Releases (no runtime needed).
#    Assets: bunqueue-dashboard-<tag>-<os>-<arch>  (linux/macos x64+arm64, windows x64)
curl -L -o bunqueue-dashboard \
  https://github.com/egeominotti/bunqueue-dashboard/releases/latest/download/bunqueue-dashboard-v0.2.5-linux-x64
chmod +x bunqueue-dashboard

# B) Build the binary yourself (needs Bun).
bun run build:bin      # → ./bunqueue-dashboard

# C) Run from source (needs Bun).
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
| `AGENT_TOKEN` | _unset_ | Bearer token required on state-changing agent requests |
| `AGENT_ALLOWED_ORIGINS` | _the served origins_ | Extra browser origins allowed to drive the agent |
| `LOG_LEVEL` | `info` | pino log level (`debug` / `info` / `warn` / `error`) |

::: tip Secure the agent
The control agent can spawn processes. It only ever binds `127.0.0.1`, but if
the box is multi-user or the dashboard is public, set an `AGENT_TOKEN` so start
/ stop / restart requires it.
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
      },
      autorestart: true,
      max_restarts: 10,
    },
  ],
};
```

Running from source instead of the binary? Use Bun as the interpreter:

```js
// script: 'scripts/serve.ts', interpreter: 'bun',
```

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
works because the control agent runs in the same process.

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
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
