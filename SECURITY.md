# Security policy

## Reporting a vulnerability

Please report security issues **privately** via GitHub's private vulnerability
reporting: open the repository's **Security** tab and choose **Report a
vulnerability**. We aim to acknowledge within a few days and will coordinate a
fix and disclosure with you.

Please do **not** open a public issue for security problems.

## Supported versions

This project is pre-1.0 and moves fast. Only the latest released `0.0.x` version
receives security fixes.

| Version      | Supported |
| ------------ | --------- |
| latest 0.0.x | ✅        |
| older        | ❌        |

## Scope and threat model

The dashboard talks only to a bunqueue server's HTTP API plus a small local
**control agent** that can start / stop / restart the bunqueue process. Because
the agent can spawn processes, it is hardened by design:

- binds **127.0.0.1** only;
- a locked **CORS Origin allowlist** (never `*`), returning `403` to a
  disallowed `Origin` (blocks drive-by CSRF);
- a fail-closed **Host allowlist** against DNS rebinding;
- an optional local **`AGENT_TOKEN`** bearer gate on state-changing requests;
- mandatory `AGENT_TOKEN` authentication on **every** `/agent/*` route when
  LAN access, proxy trust/forwarding, or a non-loopback Host/origin makes the
  all-in-one bridge remotely reachable;
- mandatory `BUNQUEUE_TOKEN` authentication on **every** `/api/*` route under
  the same remote/proxied conditions (without a configured token the proxy is
  disabled with `403`);
- a **read-only** SQLite inspector (read-only connection, statement allowlist,
  row cap).

The standalone server binds the dashboard to **loopback by default**
(`BIND_ADDR` to change). Its direct `:6800` agent listener remains loopback;
the same-origin `/agent` bridge separately detects remote/proxied policy and
fails closed without a token. A wildcard bind also requires every client-facing
name/IP in `AGENT_ALLOWED_HOSTS` or `AGENT_ALLOWED_ORIGINS`.

The all-in-one `/api/*` administrative reverse proxy is an authentication
boundary for remote access: set `BUNQUEUE_TOKEN`, then enter the same value as
the dashboard's Server token. Its Authorization header is forwarded; if the
Bunqueue server also enables `AUTH_TOKENS`, configure the same value there.
Static/Caddy deployments bypass this all-in-one boundary and must instead use
Bunqueue `AUTH_TOKENS` or front-proxy authentication. Host and Origin checks
prevent rebinding and drive-by browser requests but never replace bearer auth
for Origin-less clients such as `curl`.

Never bake server or agent bearer tokens into `VITE_*` values: those values are
plaintext in the browser bundle. Enter credentials at runtime for the current
browser session, or use an authenticating proxy. See `agent/server.ts` for the
full threat model and `docs/known-issues.md` for verified limitations.

## Verifying release artifacts

Release binaries ship with a `SHA256SUMS` file and a signed build-provenance
attestation. Verify a download with:

```bash
sha256sum -c SHA256SUMS
gh attestation verify <artifact> --repo egeominotti/bunqueue-dashboard
```
