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

Use the pinned Bun **1.4.0**, installed dependencies, Docker, and Playwright browser binaries:

```bash
bun install --frozen-lockfile
bun run test:e2e:browser:install
bun run quality
bun run test:e2e:browser
bun run test:e2e:browser:postgres-fleet
```

`quality` includes version and architecture checks, lint/format, typechecks, production and docs
builds, bundle budgets, coverage, real runtime E2E, package installation smoke tests, and the
HIGH/CRITICAL dependency audit. It does **not** include Playwright. CI runs the regular browser
matrix separately and the PostgreSQL browser scenario in its Chromium job.

The browser fixture starts an authenticated Bunqueue **2.9.4** server and the production
all-in-one dashboard under `/e2e/dashboard`. It uses a temporary SQLite database, loopback
ports **49380–49384**, and test-only tokens. Keep those ports free and run only one regular
browser suite at a time. The fixture shuts down its children and removes its database on exit.
No existing local broker or application database is used.

The PostgreSQL scenarios need a working Docker daemon and `postgres:18.6-alpine` (downloaded
on first use). They create a disposable container, namespace, three brokers and three agents.
The regular browser fixture attaches to an external test process; Fleet tests exercise managed
process controls. An external-mode disabled Start/Stop button is expected behavior.

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
| Jobs and Job Inspector | UI-created payload read back through HTTP and inspector; cross-node inspection | Operations + Fleet browser tests |
| Add Job and Bulk Add | Single submission, two-job JSON import, exact waiting count; group admission rejection | Operations + Fleet browser tests |
| Dead Letter Queue and DLQ Control | Deliberate unrecoverable job failure appears in both views; purge remains disabled | Monitoring browser tests; no production failure data |
| Cron Jobs | Cancelled confirmation does not mutate; confirmed create/delete; schedule visible across nodes | Dashboard + Fleet browser tests |
| Workflow Overview, Executions, Waiting & Signals, Compensation, Archive | All routes render; real Engine execution, recovery, signals, compensation and archive contracts | `test:e2e:workflow`; live UI commands require a managed handler module |
| Job Flows | Route renders; real FlowProducer modes and safe job operations | `test:e2e:flow`; TLS bridge also tested by `test:e2e:tls` |
| Metrics | Seed queue appears in per-queue metrics and telemetry connects | Monitoring browser tests |
| Workers | Successful real registry response and correct empty state | Monitoring browser tests; benchmark uses simulated HTTP workers, not registered SDK workers |
| Logs | Newly enqueued job arrives via SSE; search hides and restores the row | Monitoring browser tests |
| Alerts | Browser rule evaluates a real waiting job, triggers, and is deleted | Browser must stay open; no email/Slack delivery |
| Server | Managed broker stop/start from Fleet; lifecycle, restart and ownership tests | Fleet browser + runtime/lifecycle tests |
| Queue Control | Shared pause/resume, rate/concurrency limits, group priorities and pause | Fleet browser + `test:e2e:queue-operations` |
| Webhooks | Create, disable and delete a real registry entry; independent API readback | Unused queue and reserved `.invalid` URL; outbound delivery not exercised |
| Diagnostics | Server version from installed dependency, live Ping result | Operations browser tests |
| Benchmark | 40 jobs produced and processed by two simulated workers; server confirms 40 completed, zero waiting/active/failed | Operations browser test on each browser engine |
| Database | SQLite query runs through the agent and renders the returned value | Read-only connection; PostgreSQL is not a SQLite target |
| MCP | Setup/reference page renders | An external stdio client session is not launched by the browser suite |
| Usage | Runtime counters and healthy storage response render | Monitoring browser tests |
| S3 Backup | Page renders; backup agent contracts, concurrency and restore guards are tested | No real bucket upload/download/restore in this run |
| Settings | Three profiles saved; each server and agent connection tested | Fleet browser scenario |
| Copilot (launcher) | Component/tool-contract coverage | No paid provider request or model answer verified |
| Classic pages | All eleven classic routes render, including queue detail | Navigation coverage, not a duplicate mutation suite |

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
registry operations. To verify delivery, S3 restores, Copilot answers or an MCP client, use a
dedicated environment with the relevant service configured and record those results separately.
See [known limitations](known-issues.md) before interpreting intentionally disabled actions as failures.
