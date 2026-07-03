---
description: "Drive your bunqueue server from the browser: view and control queues, jobs, the dead-letter queue, cron, webhooks, workers, live activity, and the server process itself."
layout: home

hero:
  name: bunqueue dashboard
  text: Drive your queue server from the browser
  tagline: >-
    View and control queues, jobs, the dead-letter queue, cron, webhooks, workers, live activity, and the server process itself. Talks only to
    bunqueue's public HTTP API plus a tiny local control agent.
  image:
    src: /hero.svg
    alt: The bunqueue dashboard, a live queue control panel
  actions:
    - theme: brand
      text: Quick start
      link: /quickstart
    - theme: alt
      text: Live demo
      link: https://egeominotti.github.io/bunqueue-dashboard/
    - theme: alt
      text: Illustrated user guide
      link: /user-guide
    - theme: alt
      text: Architecture
      link: /architecture
    - theme: alt
      text: View on GitHub
      link: https://github.com/egeominotti/bunqueue-dashboard

features:
  - icon:
      src: /icons/control.svg
      width: 30
      height: 30
    title: Full control surface
    details: >-
      Pause/resume queues, add & retry jobs, edit rate-limit and concurrency, manage cron and webhooks, drain the DLQ, every action gated by the job's
      real state so the UI never offers something the server would reject.
    link: /user-guide
    linkText: Tour every page
  - icon:
      src: /icons/live.svg
      width: 30
      height: 30
    title: Live, not just polled
    details: >-
      Reads via cheap polling plus a Server-Sent-Events stream for real-time job
      activity, with automatic reconnect. Throughput charts update as work flows.
    link: /architecture#data-flow
    linkText: How data flows
  - icon:
      src: /icons/api.svg
      width: 30
      height: 30
    title: Two API clients by design
    details: >-
      Classic view pages on lib/api.ts; the complete, shape-verified, strict-error-checked lib/bq.ts behind every Pro control page. New work uses bq.
    link: /api-mapping
    linkText: Endpoint map & gotchas
  - icon:
      src: /icons/lifecycle.svg
      width: 30
      height: 30
    title: Process lifecycle
    details: >-
      The one thing HTTP can't do, start, stop and restart the bunqueue process, is delegated to a small local control agent (loopback-bound, CORS-locked, optional token).
    link: /agent
    linkText: The control agent
  - icon:
      src: /icons/database.svg
      width: 30
      height: 30
    title: Read-only SQLite inspector
    details: >-
      Browse tables, schema and indexes, page through rows, and run read-only
      queries with EXPLAIN and CSV/JSON export, over the agent's /db/* endpoints.
    link: /pages
    linkText: Pages & routes
  - icon:
      src: /icons/limits.svg
      width: 30
      height: 30
    title: Honest about its limits
    details: >-
      A verified, non-glossed list of current bugs and design constraints, each
      pointing at the exact file to look at.
    link: /known-issues
    linkText: Known issues
---

<div class="home-section">

## See it in action

A real control surface, not a read-only viewer, every screen below is a live
page you can drive.

<video src="/tour.mp4" autoplay muted loop playsinline preload="metadata" aria-label="A guided tour of the bunqueue dashboard: overview, queues, jobs, DLQ, flows, the SQLite inspector, and the AI Copilot" style="display:block;width:100%;max-width:1000px;margin:0.5rem auto 1.75rem;border-radius:14px;border:1px solid var(--vp-c-divider);box-shadow:0 12px 40px -12px rgba(0,0,0,.35)"></video>

<div class="home-shots">

[![Overview, real-time health at a glance](./screenshots/overview.png)](/guide/overview)

[![Jobs Explorer, filter, inspect and bulk-action jobs](./screenshots/jobs.png)](/guide/jobs)

[![SQLite inspector, browse tables and run read-only queries](./screenshots/database.png)](/guide/database)

</div>

</div>

<div class="home-section">

## Quick start

```bash
bun install
bun start          # control agent + dashboard together, Ctrl-C stops both
```

`bun start` launches the local control agent (`http://127.0.0.1:6800`) and the
dashboard (`http://localhost:5273`, `/api` proxied to `:6790`). Point it at a
bunqueue server from **Control ▸ Server** (the agent starts it for you) or via
`VITE_BUNQUEUE_URL` / the in-app Settings page.

**[Full quickstart guide →](/quickstart)**

</div>

<div class="home-section home-cta">

## Everything you can drive

<div class="home-grid">

- **Queues**, pause/resume, rate-limit, concurrency, drain, obliterate
- **Jobs**, add, inspect, promote, retry, requeue, cancel, all state-gated
- **Dead-letter queue**, reasons, per-row retry, retry-all, purge
- **Cron & webhooks**, schedule jobs, register and test endpoints
- **Workers & metrics**, live throughput, latency percentiles, worker health
- **Server process**, start / stop / restart bunqueue with live logs

</div>

Start with the **[illustrated user guide](/user-guide)**, one detailed page per
dashboard section, or read how it all fits together in the
**[architecture](/architecture)**.

</div>
