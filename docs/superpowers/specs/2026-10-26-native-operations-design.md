# Native Bunqueue operations

## Intent and authorized scope

Implement the supported portions of the user's production-improvement request.
The user's latest constraint is authoritative: use only capabilities already
exposed by Bunqueue's public HTTP API or public client. The existing Bunqueue
2.9.20 installation is the source of contract truth.

Deliver global job discovery with saved local views, grouped failure diagnosis,
native queue-metric history, and monitoring integration using native webhooks
and Prometheus. Preserve existing pages and add routes through minimal glue.

## Boundaries

- No new dashboard monitoring daemon, database, identity provider, custom alert
  delivery service, broker modifications or invented endpoints.
- No viewer/operator/admin roles, user audit trail or browser-independent custom
  threshold evaluator: Bunqueue does not expose these services.
- Preserve every existing flow/destructive-operation safety gate. Native retry
  lacks atomic incarnation/state/topology preconditions, so this change adds no
  retry, clone, replay or cleanup mutation.
- Saved search preferences are explicitly browser-local UI state, with no
  credentials, job payloads or results persisted.

## Job discovery and failures

New Search and Failures pages read configured connection profiles without
retargeting the active profile during a scan. Capture profile URLs and ephemeral
credentials once. Use public GET /dashboard/queues, GET /queues/:queue/jobs/list,
GET /queues/:queue/dlq and GET /jobs/:id; never use GET /queues/:queue/jobs,
which claims a job.

Implementation choice: extend captureServerRequestTarget with an optional
captured ConnectionProfileTarget argument. Register that immutable target and
its headers in the existing private WeakMap, so the normal bq target client
works across profiles without changing the active connection. Preserve the
existing no-argument behavior and do not expose credentials in target objects.

Search fields: job ID, custom ID, name, queue, tags and the top-level
data.correlationId value. Filters: selected profile(s), queue, state, creation
time and minimum priority. Results include source profile, queue and state.
Opening an inspector verifies the source profile is unchanged before activating
it and navigating. Existing job-inspector guards remain authoritative.

One scan has shared limits of 100 queues, 5,000 inspected jobs, 100 requests and
20 seconds. Read pages of 100 jobs and queue pages of at most 500. Abort on
navigation/new query/connection changes; ignore late results. Return explicit
coverage and errors, including skipped profiles, limits and partial scans.
Offset-based live reads are never described as an atomic snapshot. Deduplicate
by profile+queue+ID. Limit displayed results to 500 and disclose that cap.

Saved views are allowlisted query metadata, limited to 32 named entries and
32KiB stored JSON. Malformed/unavailable storage cannot break the page. URLs
support reload/back/forward for active filters; secrets never enter URLs.

Failures uses the same read scanner with failed jobs and DLQ entries, groups
normalized failure text and the first stack-trace line, and links to original
job details/logs. Normalize whitespace and UUIDs; preserve meaningful numeric
codes such as HTTP404 versus500. Show observed counts, example job IDs, queues,
profiles, and last observed failure time. Correlation is evidence, not claimed
root cause. Provide no bulk mutation.

## Native metric history

Use public Queue.getMetrics through the existing target-pinned agent bridge.
Completed and terminal-failed one-minute buckets are newest-first, separately
anchored by floor(meta.prevTS/60000)*60000. Align by timestamps and filter to the
requested wall-clock window. Offer1h/24h/7d. Calculate window totals from
returned buckets, never from cumulative meta.count. Display latest-event time,
actual coverage and missing/disabled/empty history honestly. Do not fill unknown
time with zeroes or invent historical latency percentiles.

Make the additive bridge adjustment necessary for7d: metric-only absolute index
bound100,000; explicit bounded response span at most10,080; preserve legacy end=-1
semantics. Accept at most10,080 buckets in the metrics response parser. Existing
group-pagination limits remain unchanged. Request each metric type once with
explicit end=minutes-1; no multi-page snapshot assumptions. Abort/clear stale
displays when server, token, agent or queue changes. A missing paired agent is an
explicit unavailable state. Bunqueue owns retention and persistence.

## Monitoring setup

Add a page linking the native server Webhooks screen and Prometheus endpoint,
with exportable Prometheus scrape configuration and example alert rules for the
existing Prometheus/Alertmanager integration. These are configuration exports,
not a claim that the dashboard runs a backend alert engine.

Validate configured scrape URLs as credential-free HTTP(S), rejecting query,
fragment and control characters. Serialize user values safely in YAML (JSON
quoted scalars are acceptable). Do not embed bearer tokens: optionally use a
bearer_token_file placeholder. Clearly distinguish native server event webhooks,
external metric alerting and existing browser-only rules. Document bearer-token
auth and external proxy roles as the actual current access model.

## Integration and verification

Add lazy routes /search, /failures, /metrics/history and /monitoring. Extend
navigation and page titles with minimal glue. Follow existing UI components,
keyboard labels and responsive table patterns. No new dependencies; Bun1.4.4
native checks/formatter, existing Oxlint, 300-line TypeScript limit and unchanged
coverage floors apply. New application modules require explicit test coverage.

Use TDD for scan bounds/target changes/filtering/partial results, saved views,
failure grouping, metric chronology/retention/window totals, bridge bounds and
configuration escaping. Add real browser evidence for all new screens against
disposable Bunqueue2.9.20. Run full quality, browser, package/native and docs gates
before commit/push/merge. Existing publication authorization persists.
