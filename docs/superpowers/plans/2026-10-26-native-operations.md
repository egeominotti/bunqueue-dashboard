# Native Bunqueue Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver all production improvements supported by existing Bunqueue APIs.
**Architecture:** Add frontend feature slices using existing pinned HTTP/client adapters. Keep broker-owned history and existing safety policies; persist only local search preferences.
**Tech Stack:** Bun1.4.4, React19, TypeScript, existing UI/transport, Bunqueue2.9.20.
**Spec:** `docs/superpowers/specs/2026-10-26-native-operations-design.md`

## Global Constraints

No new dependencies, custom backend services or upstream modifications. English
repository content; files<=300lines; preserve native check/fmt and coverage floors.
No new retry/replay/destructive actions. Preserve existing routes and use bq.
The latest user instruction narrows the earlier five-area request to native APIs.

## Review Focus

- Scanning one server must never send its credentials to another or claim complete results after a cap/error.
- Connection edits, cancellation and late requests must invalidate results and inspector links immediately.
- Native minute buckets have separate anchors, stale tails and partial retention; do not manufacture zeroes or percentiles.
- Saved views and monitoring YAML must not persist secrets or admit injected configuration.
- Static/demo and missing-agent deployments need truthful unavailable states, without new backend assumptions.

### Task 1: Global discovery and failure diagnosis

**Files:** Create `src/features/discovery/{model,scanner,matching,savedViews,failureGroups,useDiscovery,DiscoveryResults,GlobalSearch,FailureDiagnostics}.ts(x)` and focused tests under `test/native-discovery*.test.ts(x)`. Add modules if needed to honor300lines. Extend `src/lib/bq/targetClient.ts` only for a validated target-pinned paged queue-list reader. Extend `src/lib/bq/transport.ts::captureServerRequestTarget` with an optional captured `ConnectionProfileTarget` argument; preserve no-argument behavior and private WeakMap credential storage.

**Interfaces:** Produce named React exports `GlobalSearch` and `FailureDiagnostics`. Export `scanJobs(targets,query,signal,limits?)`, typed query/report/row contracts, pure matching/grouping functions and allowlisted saved-view storage. Consume existing `ConnectionProfileTarget`, `captureConnectionProfileTarget`, `createServerTargetClient`, `JobFull` and public endpoints described in the spec.

- [ ] Write failing behavior tests for paginated multi-profile matches, custom/correlation IDs, numeric/time filters, token isolation, partial errors, caps, cancellation, profile edits before inspect, corrupted storage and failure signatures.
- [ ] Run focused tests and observe RED; implement the feature and its two pages, including explicit scan coverage, local saved views and stale-result guards.
- [ ] Run focused tests plus frontend check/lint/formatter; self-review the complete scoped diff and report results for independent task review. Do not edit global routes/navigation/docs/version or commit until root integrates/reviews.

### Task 2: Native metric history

**Files:** Create `src/features/metric-history/{model,repository,useMetricHistory,MetricHistory}.ts(x)` and `test/native-metric-history*.test.ts(x)`; modify `agent/queue/validation.ts` and `src/features/queue-operations/infrastructure/bqQueueOperationsRepository.ts` with specific regression coverage.

**Interfaces:** Produce named `MetricHistory` React component and pure bucket/window conversion functions. Repository captures immutable server+agent targets and uses existing public Queue metrics bridge. Task1 has no dependency on this implementation.

- [ ] Write failing tests: inclusive 10,079 index support, explicit span10,081 rejection, unchanged group bounds, separate metric anchors, minute rounding, old idle tails, no invented gaps, window versus lifetime totals and target invalidation.
- [ ] Run RED; implement bounded native history with1h/24h/7d selectors, actual coverage and errors. Use explicit bounded requests per type, not end=-1 or invented persistence.
- [ ] Verify targeted tests and static gates; independent task review before integration.

### Task 3: Native monitoring setup

**Files:** Create `src/features/monitoring/{configuration,MonitoringSetup}.ts(x)` and `test/native-monitoring*.test.ts(x)`.

**Interfaces:** Produce named `MonitoringSetup` React component, `prometheusScrapeConfig(input)` and `prometheusAlertRules(input)` pure exports. Read actual server Prometheus URL; link native Webhooks and browser Alerts separately.

- [ ] Write RED tests for exact valid scheme/target/path configuration, URL credentials/query/fragment rejection, newline/YAML injection and bearer_token_file placeholder with no secrets.
- [ ] Implement export/copy UI and accurate native/external/browser capability descriptions; no outbound notifications are sent by tests.
- [ ] Verify generators, rendered controls, validation errors and focused static checks; independent task review.

### Task 4: Integration, documentation and release verification

**Files:** Minimal glue in `src/App.tsx`, `src/components/layout/Sidebar.tsx`, `src/components/layout/pageTitle.ts`; update demo adapters only for genuine native read shapes if needed; new browser scenarios under `e2e/`; update docs, README, `package.json`, CHANGELOG.

- [ ] Integrate four lazy routes and navigation; update source-verified public guides, API mapping and explicit unsupported capabilities.
- [ ] Add real Bunqueue browser tests for native discovery, failure groups, queue-history data and monitoring exports. Keep each scenario isolated with unique queues; root owns shared browser ports and builds.
- [ ] Run complete native typecheck/lint/fmt, architecture, bundle budgets, unit/critical coverage, runtime and browser groups, docs and audit. Validate no loss of prior safety gates.
- [ ] Perform a fresh whole-branch review, fix important findings with RED/GREEN evidence, bump release to1.1.0 with changelog, then commit/push/merge using existing authorization and protected CI gate.
