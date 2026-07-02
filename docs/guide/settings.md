---
title: Settings
---

# Settings

> Route `/settings` · source `src/pages/Settings.tsx`

![Settings](../screenshots/settings.png)

The single settings page for the whole dashboard. It decides **which bunqueue server** every page talks to (the `:6790` HTTP API), holds an optional **bearer token**, and controls the two global UI preferences — **theme** and **polling interval** — that every auto-refreshing page reads.

::: info Scope
This page configures the dashboard's connection to the **bunqueue HTTP API** only. The local **control agent** (`127.0.0.1:6800`, used by the Control/Pro pages to start-stop the server process) is not configured here — it is discovered separately by those pages.
:::

## What it shows

The page is a single `max-w-2xl` column with a `PageHeader` ("Settings" / "Connection and appearance.") and two `Card`s.

### Connection card

| Field | Meaning |
| --- | --- |
| **Server URL** | The base URL the dashboard points at. A local buffer, seeded from the stored `baseUrl`. Placeholder `/api or https://queue.example.com`. Helper text: use `/api` in dev (Vite proxy to `localhost:6790`), or the server origin in production. |
| **Bearer token (optional)** | Sent as `Authorization: Bearer …` on API calls. Rendered as a password field with a show/hide eye (`IconEye`) toggle. Placeholder `only if AUTH_TOKENS is set`. Hint: kept in memory only — re-enter after reload, or set `VITE_BUNQUEUE_TOKEN`. |

Inline feedback next to the buttons:

- **`Saved ✓`** (green) — appears for ~2 s after a successful Save.
- **Test result** — green on success (e.g. `Connected in 12ms · bunqueue v…`), red on failure (the error message).
- **URL error** (red, below the input) — `Must be an http(s) URL or a path starting with '/'.` when validation fails.

### Appearance & refresh card

Two side-by-side `Select`s:

| Field | Meaning |
| --- | --- |
| **Theme** | `Dark` or `Light`. Bound to `useThemeStore`; applies immediately and persists. |
| **Refresh interval** | Polling cadence used by every auto-refreshing page: `1 second`, `2 seconds`, `3 seconds`, `5 seconds`, `10 seconds` (values `1000`–`10000` ms; default `3000`). |

## What you can do

| Action | Effect | Confirm? |
| --- | --- | --- |
| Edit **Server URL** | Updates the local buffer only — nothing retargets until you Save. | — |
| **Save** | Validates the URL, then commits URL + token to the connection store (URL trailing slash stripped). Shows `Saved ✓`. On invalid URL, sets the inline error and does **not** save. | No |
| Enter **Bearer token** | Buffered locally until Save. | — |
| **Show/Hide** token (eye button) | Toggles the token field between `password` and `text`. | — |
| **Test connection** | Calls the server's `/health` (via `api.health()`), times the round-trip, and reports `Connected in <ms>ms · bunqueue v<version>`, or the error. Button shows `Testing…` while in flight. | No |
| Change **Theme** | Applies and persists immediately (no Save needed). | No |
| Change **Refresh interval** | Applies and persists immediately (no Save needed). | No |

::: tip Buffered inputs
Server URL and token are held in local component state (`url`, `tok`) and only pushed to the store on **Save**. This is deliberate: committing on every keystroke would retarget all polling at a half-typed URL. Theme and refresh interval, by contrast, write straight to their stores on change.
:::

**URL validation** (`isValidBaseUrl`): a value starting with `/` is always accepted (relative dev-proxy path); otherwise it must parse as a URL with an `http:` or `https:` protocol. Anything else is rejected before saving.

## States & gating

- **No loading/empty/error page states.** This page fetches nothing on mount — it renders instantly from the two Zustand stores. There is no list, no polling here, so no skeletons or empty states.
- **Save** is never disabled; it either commits or shows the inline URL error.
- **Test connection** is disabled while a test is in flight (`testing`), with the label switching to `Testing…`.
- **URL error** clears as soon as you edit the field again (`onChange` resets `urlError`).
- **Offline / bad target**: nothing on this page breaks when the server is unreachable — Test simply reports the failure; other pages are what surface the connection state (sidebar pill, per-page errors).

This page has no job-action gating (`src/lib/jobActions.ts` is not involved).

## Behind the scenes

- **Test connection** is the only network call: `api.health()` → `GET /health` on the classic `api` client (`src/lib/api.ts`). It is called with the non-strict flag so a `{ ok: false }` health payload is not treated as a thrown error — `/health`'s `ok` means "is the server healthy", not "did the request succeed" (see `docs/api-mapping.md`). `GET /health` returns `{ ok, status, version, uptime, queues, connections, memory… }`; the page reads only `ok` and `version`.
- **Persistence** (Zustand `persist`):
  - Connection store `bq-dash-connection` (v1) persists **only** `baseUrl` and `refreshMs` via `partialize`/`migrate`. `setBaseUrl` strips a trailing slash; `setRefreshMs` clamps to a `500 ms` minimum. Defaults: `baseUrl` = `VITE_BUNQUEUE_URL` or `/api`, `refreshMs` = `3000`.
  - Theme store `bq-dash-theme` persists `theme` and re-applies it to `document.documentElement` on rehydrate.
- **Token** is **never persisted** — it lives in memory only (same at-rest tradeoff as the S3 keys). Seed it at build time with `VITE_BUNQUEUE_TOKEN`, or re-enter it each session.
- No SSE stream and no polling originate from this page.

## Gotchas

::: warning Token does not survive reload
The bearer token is intentionally kept in memory only and excluded from `localStorage`; you must re-enter it after every reload (or bake `VITE_BUNQUEUE_TOKEN` in at build time). The store even scrubs tokens written by older builds on rehydrate.
:::

- **Save commits both URL and token together** — there is no separate "apply token" action. If you typed a token but never Saved, it isn't in effect yet.
- **Test uses the *saved* connection**, not the buffered fields: `api.health()` reads the committed store values. Save first, then Test, to check edits you just made.
- **Refresh interval floor**: values below `500 ms` are clamped by the store, but the dropdown only offers `1 s`–`10 s`, so this only matters if the value is set programmatically.
- **This is the only settings surface** — both the classic and Pro (Control) page families read the connection/theme it configures; there is no per-page override.
- The agent (`:6800`) is not configurable here; nothing on this page affects the Control server-lifecycle pages' connection to it.
