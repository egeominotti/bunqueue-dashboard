---
title: Testing & verification
description: Reproduce real Bunqueue dashboard tests and understand the evidence available for each section.
---

# Testing & verification

A page rendering successfully is a navigation check. An operation is verified when a real
server accepts it and the resulting data or state is observed. The dashboard uses both types
of checks, plus component and contract tests for races, malformed responses and disabled actions.
The public demo uses fixtures; it does not prove connectivity or persistence.

## Reproduce locally

Use the pinned Bun **1.4.2**, installed dependencies, Docker, and Playwright browser binaries:

```bash
bun install --frozen-lockfile
bun run test:e2e:browser:install
bun run quality
bun run test:e2e:browser
bun run test:e2e:browser:postgres-fleet
bun run test:e2e:browser:managed
bun run test:e2e:docs
```

`quality` includes version and architecture checks, lint/format, typechecks, production and docs
builds, bundle budgets, coverage, real runtime E2E, package installation smoke tests, and the
HIGH/CRITICAL dependency audit. It does **not** include Playwright. CI runs the regular browser
matrix separately and the PostgreSQL and managed-server scenarios in its Chromium job.

The browser fixture starts an authenticated Bunqueue **2.9.4** server and the production
all-in-one dashboard under `/e2e/dashboard`. It uses a temporary SQLite database, loopback
ports **49380–49384**, and test-only tokens. Keep those ports free and run only one regular
or managed browser suite at a time. The fixture shuts down its children and removes its database on exit.
No existing local broker or application database is used.

The PostgreSQL scenarios need a working Docker daemon and `postgres:18.6-alpine` (downloaded
on first use). They create a disposable container, namespace, three brokers and three agents.
The regular browser fixture attaches to an external test process; Fleet tests exercise managed
process controls. An external-mode disabled Start/Stop button is expected behavior.

The managed browser suite uses the same reserved ports plus **49390** for a disposable local MinIO S3 endpoint. It starts the pinned Bunqueue CLI through the agent,
registers the test Workflow module, and verifies UI commands against that server.
MinIO has no host mounts and uses only synthetic local credentials. Its container
is removed afterward; a pre-existing image is retained. No cloud bucket is used.
The local model fixture is a scripted HTTP provider, not a language model.

For focused browser work after a production build:

```bash
bun run build
bun scripts/gen-embed.ts
bunx playwright test e2e/operations.e2e.ts --project=chromium
bunx playwright test e2e/monitoring.e2e.ts --project=chromium
```

## Section coverage

All **30 sidebar destinations**, the classic pages, the legacy Cron redirect and the 404
fallback are visited on Chromium, Firefox and WebKit. The table describes the additional
behavioral evidence; it does not claim every possible button and configuration is covered.

| Section | Real verification | Scope or prerequisite |
| --- | --- | --- |
| Overview | Authenticated dashboard data; SSE recovery after an actual broker restart | `dashboard.e2e.ts` |
| Fleet | Three healthy APIs, shared PostgreSQL target/namespace, cross-node state | PostgreSQL browser scenario |
| Queues and queue detail | Submitted queue appears; detail opens; pause/resume observed across brokers | Operations + Fleet browser tests |
| Jobs and Job Inspector | UI-created payload readback; priority/delay changes, promotion, log add/clear and unavailable destructive actions | Operations, managed and Fleet browser tests |
| Add Job and Bulk Add | Single submission, two-job JSON import, exact waiting count; group admission rejection | Operations + Fleet browser tests |
| Dead Letter Queue and DLQ Control | Deliberate unrecoverable job failure appears in both views; purge remains disabled | Monitoring browser tests; no production failure data |
| Cron Jobs | Cancelled confirmation does not mutate; confirmed create/delete; schedule visible across nodes | Dashboard + Fleet browser tests |
| Workflow Overview, Executions, Waiting & Signals, Compensation, Archive | UI start, durable signal, resume/abandon compensation, archive/history, reload, orphan recovery and terminal cleanup | Managed browser suite with real registered handler module; `test:e2e:workflow` covers runtime contracts |
| Job Flows | All five FlowProducer create modes, fourteen inspection methods and a safe log mutation through the UI | Managed browser suite plus all safe runtime operations in `test:e2e:flow` |
| Metrics | Seed queue appears in per-queue metrics and telemetry connects | Monitoring browser tests |
| Workers | MCP registration/heartbeat/unregister; active record displayed; naturally stale idle record removed through UI | Managed browser suite; registry-only fixtures do not run consumer processes |
| Logs | Newly enqueued job arrives via SSE; search hides and restores the row | Monitoring browser tests |
| Alerts | Browser rule evaluates a real waiting job, triggers, and is deleted | Browser must stay open; no email/Slack delivery |
| Server | Managed start/stop/restart, generation and process logs | Managed and Fleet browser suites plus lifecycle tests |
| Queue Control | Stall/DLQ policy save, delayed promotion, Queue SDK metrics and journal trim; shared limits and group policy | Managed, Fleet and `test:e2e:queue-operations` suites |
| Webhooks | Create, disable and delete a real registry entry; independent API readback | Unused queue and reserved `.invalid` URL; outbound delivery not exercised |
| Diagnostics | Server version and Ping; real GC, heap statistics and independent readiness probes | Operations and managed browser tests |
| Benchmark | 40 jobs produced and processed by two simulated workers; server confirms 40 completed, zero waiting/active/failed | Operations browser test on each browser engine |
| Database | Real SQLite schema, row filter, CSV export, SQL result and rejected write with unchanged data | Managed browser suite; PostgreSQL is not a SQLite target |
| MCP | Actual stdio client discovers 73 tools, 5 resources and 3 prompts; stats resource and health prompt read | Pinned public executable with explicit optional SDK; not all 73 tools executed |
| Usage | Runtime counters and healthy storage response render | Monitoring browser tests |
| S3 Backup | UI config, real upload/list to local MinIO, stopped-server restore and readback proving a later job disappeared | Managed browser suite; cloud-specific authentication and networking not exercised |
| Settings | Theme/poll interval survive reload; three profiles saved and each connection tested | Managed and Fleet browser suites; credentials remain session-only |
| Copilot (launcher) | Streaming, declined/confirmed mutation, Stop without mutation or unhandled errors, Clear chat | Scripted local provider with real queue writes; no model inference or paid provider requests |
| Classic pages | All eleven classic routes render, including queue detail | Navigation coverage, not a duplicate mutation suite |

## Current regression additions (0.0.45)

The managed suite adds **13 Chromium scenarios** against Bunqueue **2.9.4**.
It supplements the existing **42 tests** across Chromium, Firefox and WebKit and
the three-broker PostgreSQL scenario. The commands above are the reproducible
source of results; CI retains diagnostics when a scenario fails.

Two browser issues found by these tests are fixed: the Copilot custom Base URL
field now has an explicit accessible label, and the AI SDK's browser telemetry
completion promise is handled when Stop aborts a turn. The latter is a minimal,
version-pinned Bun patch in `patches/ai@7.0.14.patch`, applied during a frozen
install and tested in the production browser bundle. It does not suppress global
browser errors or alter tool confirmation.

Bunqueue's MCP TCP registration can return ID `"0"` despite storing another ID.
That upstream limitation and the verified registry lookup workaround are recorded
in [MCP setup](/guide/mcp#verified-tcp-worker-limitation).

## Documentation browser checks

`bun run test:e2e:docs` builds VitePress and tests every generated content page at
its clean URL on desktop (1440 px) and mobile (390 px). It checks the hydrated
page, browser errors and document overflow, then exercises search, navigation
and Back. The fixture reserves loopback port **49556** and runs in Chromium CI.
Static dead-link checks run during `docs:build`; browser checks additionally catch
client routing failures that a valid HTML response alone cannot detect.

The custom view-transition wrapper preserves VitePress's router options and
skips the initial load. Dropping `initialLoad` previously caused direct clean URLs
to hydrate into the 404 page, even though the server returned the right HTML.
This regression is covered by the URL checks above.

## Results recorded on 2026-09-05

The verification uses Dashboard **0.0.43**, Bun **1.4.0**, Bunqueue **2.9.4**, and PostgreSQL
**18.6** (schema **20**) for Fleet. These are dated results, not a guarantee for later commits.

- The canonical quality gate passed: **1,050 Bun tests**, **0 failures**, with aggregate logic
  coverage **89.82% lines / 90.75% functions** (the configured floor excludes TSX).
- Real TLS, SQLite schema 35 → 37 migration, Flow, Workflow, Queue SDK, PostgreSQL Fleet and
  packed-package runtime checks passed.
- **42 browser tests passed in 43.6 seconds** across Chromium, Firefox and WebKit: navigation,
  accessibility and eight additional operational scenarios per browser. The benchmark reconciled
  **120 completed jobs** across the three engines (40 each).
- The PostgreSQL UI scenario passed after removing an obsolete hard-coded 2.9.3 version
  expectation. It now compares the connection result with the version probed on the real broker.

## Evidence and troubleshooting

Playwright prints each scenario and browser result. Failures retain screenshots, videos and
traces in `test-results/`; open a trace with `bunx playwright show-trace <path-to-trace.zip>`.
Runtime scenarios print their assertions and JSON summaries. To retain local evidence:

```bash
bun run quality > /tmp/dashboard-quality.log 2>&1
bun run test:e2e:browser > /tmp/dashboard-browser.log 2>&1
bun run test:e2e:browser:postgres-fleet > /tmp/dashboard-fleet-browser.log 2>&1
```

If authentication appears after a full reload, enter the test/server token again: credentials
are held in memory and are not persisted to browser storage. A reserved webhook URL only tests
registry operations. Verify outbound delivery/signatures, cloud-specific S3 access and actual
Copilot model answers in a dedicated environment with those services configured, and record
the provider, model and results separately. Local S3 restore and MCP checks are in the managed suite.
See [known limitations](known-issues.md) before interpreting intentionally disabled actions as failures.
