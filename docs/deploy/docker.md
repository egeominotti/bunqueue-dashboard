---
title: Docker
description: Run the bunqueue dashboard as a Docker container, served by Caddy. Pull the published image, run with docker or docker compose, or build your own.
---

# Docker

The image is a **multi-stage build**: Bun compiles the SPA, then **Caddy**
serves the static files (gzip + zstd, SPA history fallback, immutable asset
caching). It listens on port **80**.

## Run the published image

Every push to `main` publishes `edge`; tagged releases publish `latest` and the
semver tag.

```bash
docker run --rm -p 8080:80 ghcr.io/egeominotti/bunqueue-dashboard:edge
# → http://localhost:8080
```

Then open **[Settings](/guide/settings)** and point it at your bunqueue server,
or bake the origin in at build time (below).

::: tip Pin a version in production
Prefer `:latest` or a specific `:vX.Y.Z` over `:edge` for anything you depend on.
:::

## docker compose

```yaml
services:
  dashboard:
    image: ghcr.io/egeominotti/bunqueue-dashboard:latest
    ports:
      - "8080:80"
    restart: unless-stopped
```

```bash
docker compose up -d
```

## Build your own image

Bake a default server origin in at build time so users do not have to set it in
Settings:

```bash
docker build \
  --build-arg VITE_BUNQUEUE_URL=https://queue.example.com \
  -t bunqueue-dashboard .

docker run --rm -p 8080:80 bunqueue-dashboard
```

`VITE_BUNQUEUE_URL` is a **build argument**, not a runtime env var: the value is
compiled into the bundle. To change it later, rebuild (or override it at runtime
from the Settings page).

## Same-origin API proxy

By default the image is a **pure static server**: the browser calls your
bunqueue server directly, so that server needs CORS for the dashboard's origin.

To avoid CORS entirely, serve the dashboard and proxy `/api/*` to bunqueue from
the **same** origin. Extend the Caddyfile:

```txt
:80 {
	root * /usr/share/caddy
	encode gzip zstd

	# Forward /api/* to the bunqueue server, stripping the /api prefix.
	handle_path /api/* {
		reverse_proxy bunqueue:6790
	}

	@assets path /assets/*
	header @assets Cache-Control "public, max-age=31536000, immutable"

	try_files {path} /index.html
	file_server
}
```

Leave `VITE_BUNQUEUE_URL` **unset** so the client uses the default `/api` path,
which Caddy now proxies. `handle_path` strips `/api`, so `/api/dashboard`
reaches bunqueue as `/dashboard`, exactly like the dev proxy and the all-in-one
server.

Mount the file over the image's default and put both containers on one network:

```yaml
services:
  dashboard:
    image: ghcr.io/egeominotti/bunqueue-dashboard:latest
    ports: ["8080:80"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
  bunqueue:
    image: your/bunqueue-server
    # exposes :6790 on the internal network
```

## Health check

The image ships a `HEALTHCHECK` that curls `/` every 30s, so orchestrators see
`healthy` / `unhealthy` out of the box.

## Want process control too?

This image is static and has **no control agent**, so Server Control (start /
stop / restart) is not available in it, by design (a hosted static site should
not spawn processes). For the full control surface, run the
**[all-in-one server](/deploy/pm2)** where the dashboard also manages the
bunqueue process.
