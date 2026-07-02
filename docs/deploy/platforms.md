---
title: Hosting platforms
description: Deploy the bunqueue dashboard to Vercel, Netlify, Cloudflare Pages, GitHub Pages, Render, Fly.io, Railway, or Google Cloud Run. Copy-paste config for each.
---

# Hosting platforms

The dashboard builds to a static `dist/` folder, so it drops onto any host. Two
families: **static hosts** (serve the files) and **container hosts** (run the
Docker image).

Everywhere, the build is the same:

```bash
bun install && bun run build      # → dist/
```

Set `VITE_BUNQUEUE_URL` to your server's origin (a build-time env var on the
platform), or leave it and configure the target from the in-app
**[Settings](/guide/settings)** page. On a static host the browser calls
bunqueue **directly**, so that server needs **CORS** for your dashboard domain.

Every static host also needs a **history-API fallback** (serve `index.html` for
unknown paths) or deep links 404. That is the one config each platform below
sets.

## Static hosts

### Vercel

`vercel.json` in the repo root:

```json
{
  "buildCommand": "bun run build",
  "outputDirectory": "dist",
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

Set `VITE_BUNQUEUE_URL` under Project Settings, Environment Variables. Deploy
with `vercel --prod` or connect the Git repo.

### Netlify

`netlify.toml` in the repo root:

```toml
[build]
  command = "bun run build"
  publish = "dist"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

### Cloudflare Pages

- Build command: `bun run build`
- Build output directory: `dist`
- SPA fallback: add a `public/_redirects` file (Vite copies it into `dist`):

```
/*    /index.html    200
```

### GitHub Pages

Served under a repo sub-path, so build with the base path and add a `404.html`
that mirrors `index.html` (Pages serves it for unknown routes):

```bash
VITE_BASE=/your-repo/ bun run build
cp dist/index.html dist/404.html
```

Publish `dist/` with `actions/deploy-pages`. This repo already does exactly this
for the docs site in `.github/workflows/pages.yml`.

### Render (static site)

- Build command: `bun install && bun run build`
- Publish directory: `dist`
- Add a rewrite rule: Source `/*`, Destination `/index.html`, Action **Rewrite**.

## Container hosts

These run the [Docker image](/deploy/docker) (Caddy already handles the SPA
fallback, so there is nothing extra to configure).

### Fly.io

```bash
fly launch --image ghcr.io/egeominotti/bunqueue-dashboard:latest
```

Ensure `fly.toml` has `internal_port = 80`, then `fly deploy`. Fly terminates
TLS for you.

### Railway

New project, Deploy from the repo (Railway builds the `Dockerfile`), or Deploy
an image and paste `ghcr.io/egeominotti/bunqueue-dashboard:latest`. Set the
service port to **80**.

### Google Cloud Run

```bash
gcloud run deploy bunqueue-dashboard \
  --image ghcr.io/egeominotti/bunqueue-dashboard:latest \
  --port 80 \
  --allow-unauthenticated \
  --region europe-west1
```

Cloud Run injects TLS and a public URL, and scales to zero when idle.

## Want the API proxy and process control?

All of the above serve the **static** build (no control agent, browser talks to
bunqueue directly). For a same-origin `/api` proxy **and** Server Control, run
the **[all-in-one server](/deploy/pm2)** on a VM (PM2 / systemd) or as a
container, and point these platforms' proxy or your load balancer at it.
