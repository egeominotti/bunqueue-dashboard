---
title: Settings
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
| **Theme** | Switch between **Dark** and **Light**. |
| **Refresh interval** | How often the live pages reload their data: 1, 2, 3, 5, or 10 seconds. |

Small messages appear next to the buttons: a green **Saved ✓** after you save, a green or red result after you test a connection, and a red note under the URL box if what you typed isn't a valid address.

## What you can do

- **Save your connection.** Type a Server URL (and token if needed), then click **Save**. The dashboard checks the address, applies it everywhere, and shows **Saved ✓**. If the address isn't valid, it shows an error and keeps your old settings.
- **Test a connection.** Click **Test connection** to ping the server and confirm it answers. On success you'll see how fast it replied and the server version (for example, *Connected in 12ms · bunqueue v…*); on failure you'll see the error. The button reads **Testing…** while it works.
- **Show or hide the token.** Use the eye button to reveal or mask the token field.
- **Change the theme.** Pick Dark or Light — it applies instantly and is remembered.
- **Change the refresh interval.** Pick a speed — it applies instantly and is remembered.

::: tip Save before you test
**Test connection** checks the server you've already saved, not what's currently typed in the box. Save your changes first, then test.
:::

## Good to know

- **Server URL and token only take effect when you Save.** Typing alone changes nothing — the dashboard keeps using the last saved values until you click **Save**. This is deliberate, so it never tries to reload data from a half-typed address.
- **The token is not remembered after you reload.** For security, the token is kept in memory only and cleared when you refresh or close the tab. Re-enter it each session, or have it built into your deployment ahead of time.
- **Theme and refresh interval are remembered.** They persist across reloads automatically.
- **This is the only place to set the connection.** Every page — classic and Pro — uses the server, theme, and refresh speed you choose here. There's no per-page override.
- **Starting or stopping the server lives elsewhere.** This page only chooses which running server to read from. To start, stop, or restart the server process, use **Control ▸ Server**.
- **Nothing here breaks when the server is offline.** If the server is unreachable, Test simply reports the failure; the connection status shown around the rest of the dashboard is what tells you something's wrong.

::: details Under the hood (for developers)
- **Test connection** is the page's only network call: `GET /health` via the classic `api` client, timed for the round-trip and read for `ok` + `version` (non-strict, since `/health`'s `ok` is a health flag, not a request-success flag).
- **No polling or SSE** originates here — the page renders instantly from local stores and fetches nothing on mount.
- **Persistence:** the connection store saves only the base URL (trailing slash stripped) and refresh interval (floored at 500 ms); theme is saved separately and re-applied on load. The bearer token is deliberately excluded from storage. Defaults: URL = `VITE_BUNQUEUE_URL` or `/api`, refresh = 3000 ms.
- This screen configures the bunqueue HTTP API connection only; the local control agent (`127.0.0.1:6800`) used by the Control/Pro pages is discovered separately.
:::
