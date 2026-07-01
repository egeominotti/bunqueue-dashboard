# How the dashboard works

Internal reference for the bunqueue dashboard. Everything here was verified
against the current source (not written from memory or assumption) — where
the code has a rough edge, it's documented rather than glossed over.

- [architecture.md](architecture.md) — components, data flow, the two API
  clients, the control agent, theming.
- [pages.md](pages.md) — every route, exactly which component it renders,
  which API client it uses, and what it does. Start here if you're not sure
  which page owns a piece of functionality — several routes render a
  different page family than their path would suggest.
- [components.md](components.md) — the UI kit, layout shell, Zustand stores,
  and shared `lib/` helpers that every page is built from.
- [agent.md](agent.md) — the local control agent that starts/stops/restarts
  the bunqueue server process, and its `/control/*` endpoints.
- [api-mapping.md](api-mapping.md) — endpoint map, request bodies,
  **verified response-shape gotchas**, the job-action state-gating table, and
  the "strict mode" `{ok:false}`-on-HTTP-200 handling.
- [known-issues.md](known-issues.md) — verified, honest list of current bugs
  and limitations, each with the exact file to look at.
- [development.md](development.md) — run / build / test / lint, and how to
  add a page (additively).

## One-paragraph overview

The dashboard is a Vite + React 19 single-page app. It **reads** from a
bunqueue server's HTTP API by polling (`usePolledData`, interval from the
connection store) and by subscribing to the Server-Sent Events stream
(`useActivityStream`) for live job activity. It **writes** through the same
HTTP API (pause, add job, retry, rate-limit, …), with every job action gated
by the job's actual current state so the UI never offers an action the server
would reject (`lib/jobActions.ts`). The one thing HTTP cannot do — manage the
server *process* — is delegated to a tiny local **control agent** (`agent/`)
that the dashboard calls over `/control/*` to start, stop and restart
bunqueue; that agent has **no authentication** today (see
[known-issues.md](known-issues.md)), so keep it off any network beyond your
own loopback.

Two API clients coexist: `src/lib/api.ts` (original view pages, the
**classic** family) and `src/lib/bq.ts` (the complete, shape-verified,
strict-error-checked client behind every `pages/control/*` **Pro** page). New
work always uses `bq`. The two families overlap by design — see
[pages.md](pages.md#sidebar--page-mapping) for exactly where and why.
