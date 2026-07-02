---
layout: home

hero:
  name: bunqueue dashboard
  text: Drive your queue server from the browser
  tagline: >-
    View and control queues, jobs, the dead-letter queue, cron, webhooks,
    workers, live activity — and the server process itself. Talks only to
    bunqueue's public HTTP API plus a tiny local control agent.
  actions:
    - theme: brand
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
      Pause/resume queues, add & retry jobs, edit rate-limit and concurrency,
      manage cron and webhooks, drain the DLQ — every action gated by the job's
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
      Classic view pages on lib/api.ts; the complete, shape-verified,
      strict-error-checked lib/bq.ts behind every Pro control page. New work uses bq.
    link: /api-mapping
    linkText: Endpoint map & gotchas
  - icon:
      src: /icons/lifecycle.svg
      width: 30
      height: 30
    title: Process lifecycle
    details: >-
      The one thing HTTP can't do — start, stop and restart the bunqueue process —
      is delegated to a small local control agent (loopback-bound, CORS-locked,
      optional token).
    link: /agent
    linkText: The control agent
  - icon:
      src: /icons/database.svg
      width: 30
      height: 30
    title: Read-only SQLite inspector
    details: >-
      Browse tables, schema and indexes, page through rows, and run read-only
      queries with EXPLAIN and CSV/JSON export — over the agent's /db/* endpoints.
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
