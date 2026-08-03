---
title: Settings
description: "Point the dashboard at your bunqueue server and choose how it looks and how often it refreshes."
---

# Settings

Point the dashboard at your bunqueue server and choose how it looks and how often it refreshes.

**Where:** open `/settings` from the sidebar.

![Settings](../screenshots/settings.png)

## What you'll see

One simple page with two cards: **Connection** (which server the dashboard talks to) and **Appearance & refresh** (how it looks and how fast it updates).

| Element | What it tells you |
| --- | --- |
| **Server URL** | The address of the bunqueue server every page reads from. Use `/api` during local development, or the full server address (like `https://queue.example.com`) in production. |
| **Bearer token (optional)** | A secret token sent with each request, only needed if your server requires one. Shown as dots; use the eye button to reveal it. |
| **Agent token (optional)** | The independent `AGENT_TOKEN` used by Server Control and the SQLite inspector. It is never sent to the bunqueue server. |
| **Theme** | Switch between **Dark** and **Light**. |
| **Refresh interval** | How often the live pages reload their data: 1, 2, 3, 5, or 10 seconds. |

Small messages appear next to the buttons: a green **Saved ✓** after you save, a green or red result after you test a connection, and a red note under the URL box if what you typed isn't a valid address.

## What you can do

- **Save your connection.** Type a Server URL (and tokens if needed), then click **Save**. The dashboard validates and applies the three fields as one update. It shows **Saved ✓** when the non-secret settings were persisted, or an explicit session-only warning if browser storage is blocked/full. If the address isn't valid, it shows an error and keeps your old settings.
- **Test a connection.** Click **Test connection** to probe the URL and bearer token currently in the form. On success you'll see how fast it replied and the Bunqueue version (for example, *Connected in 12ms · bunqueue v…*); a reachable degraded server is labelled as such. Starting another test, editing/saving the draft, changing the active connection, or leaving the page cancels the obsolete probe. While a probe runs, the button reads **Restart test**.
- **Show or hide the token.** Use the eye button to reveal or mask the token field.
- **Change the theme.** Pick Dark or Light, it applies instantly and is remembered.
- **Change the refresh interval.** Pick a speed, it applies instantly and is remembered.

::: tip Test before you save
**Test connection** deliberately checks the URL and bearer token currently typed in the form, so you can verify a new target before applying it to every dashboard page.
:::

## Good to know

- **Server URL and token only take effect when you Save.** Typing alone changes nothing, the dashboard keeps using the last saved values until you click **Save**. This is deliberate, so it never tries to reload data from a half-typed address.
- **Tokens are not remembered after you reload.** For security, both the bunqueue bearer and agent token are kept in memory only and cleared when you refresh or close the tab. Re-enter them each session.
- **Theme and refresh interval are remembered.** They persist across reloads automatically.
- **This is the only place to set the connection.** Every page, classic and Pro, uses the server, theme, and refresh speed you choose here. There's no per-page override.
- **Starting or stopping the server lives elsewhere.** This page only chooses which running server to read from. To start, stop, or restart the server process, use **Control ▸ Server**.
- **Nothing here breaks when the server is offline.** If the server is unreachable, Test simply reports the failure; the connection status shown around the rest of the dashboard is what tells you something's wrong.

::: details Under the hood (for developers)
- **Test connection** is the page's only network call: a cancellable, deadline-bounded `GET /health`. A successful response must carry Bunqueue's coherent `ok`, `status`, `uptime`, and semantic `version` fingerprint; HTTP 503 with `status: "degraded"` remains a reachable diagnostic response.
- **No polling or SSE** originates here, the page renders instantly from local stores and fetches nothing on mount.
- **Persistence:** the connection store saves only the canonical base URL and refresh interval (clamped to 500–60,000 ms); theme is saved separately and re-applied on load. Both tokens are deliberately excluded, and legacy blobs are rewritten without secrets during hydration. Defaults: URL = a validated `VITE_BUNQUEUE_URL` or `/api`, refresh = 3000 ms.
- The control agent target is resolved separately from a validated runtime `/agent` injection, a validated `VITE_BUNQUEUE_AGENT_URL`, or the safe development default `http://localhost:6800`. Its independent token is configured on this screen.
:::
