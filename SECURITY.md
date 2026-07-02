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
- an optional **`AGENT_TOKEN`** bearer gate on state-changing requests;
- a **read-only** SQLite inspector (read-only connection, statement allowlist,
  row cap).

The standalone server binds the dashboard to **loopback by default**
(`BIND_ADDR` to change). See `agent/server.ts` for the full threat model and
`docs/known-issues.md` for verified limitations. When self-hosting, keep the
agent port on a trusted network and set `AGENT_TOKEN` on shared or exposed
hosts.

## Verifying release artifacts

Release binaries ship with a `SHA256SUMS` file and a signed build-provenance
attestation. Verify a download with:

```bash
sha256sum -c SHA256SUMS
gh attestation verify <artifact> --repo egeominotti/bunqueue-dashboard
```
