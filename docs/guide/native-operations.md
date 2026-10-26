---
title: Native operations
description: "Cross-profile job discovery, failure signatures, retained queue history and native monitoring integration."
---

# Native operations

The dashboard reads existing Bunqueue APIs to find jobs across connection
profiles, compare failure signatures, inspect retained queue history and prepare
external monitoring. Server data and retention remain owned by Bunqueue.

## Find jobs across profiles

Open **Search**, select the configured profiles and filters, and run a scan.
The query can match job IDs, custom IDs, names, queue names, tags and a
top-level `data.correlationId`. Results identify their source profile and queue.
The inspector activates that source only after checking its connection is
still the one used by the scan.

Each scan reads at most 100 queues, 5,000 jobs and 100 HTTP requests within
20 seconds, with at most 500 displayed matches. The coverage report identifies
errors, skipped profiles and limits. Live offset pages can move while the
server processes jobs; they are not an atomic snapshot or an exhaustive index.
Search uses the native read-only `/jobs/list` endpoint and never claims jobs.

Saved views hold only filter preferences in this browser, with up to 32 named
views and 32KiB of storage. They contain no tokens, payloads or result cache.
Tokens remain in memory and must be entered again after a full page reload.

## Compare failures

**Failures** scans failed jobs and DLQ entries and groups normalized error text
and the first stack line. Repeated UUIDs and whitespace are normalized;
meaningful numbers such as HTTP 404 and 500 remain distinct. Counts describe
observations within that scan. A shared signature is evidence to investigate,
not a diagnosis of the root cause. Open examples in the existing inspector to
read their details and logs.

## Retained queue history

**Metric history** uses the public `Queue.getMetrics` client through the
existing paired managed agent. Choose a queue and a 1-hour, 24-hour or 7-day
window. Completed and terminal-failed counts use native minute buckets and
their individual event anchors. Totals come from the retained buckets inside
the selected window, rather than the broker's lifetime counters.

Bunqueue controls retention and persistence; its default metric retention is
20,160 minute buckets. Retention can be disabled. Idle queues can have old
tails, and missing buckets are unknown rather than fabricated zeroes. The
page reports the history actually returned. It does not store another history
database or invent historical latency percentiles. A missing, stopped or
mismatched managed agent makes this client-only history unavailable.

## External monitoring

**Monitoring setup** exports Prometheus scrape configuration and example alert
rules for native metrics. Configure a URL reachable by your Prometheus server
and install the output in Prometheus; Alertmanager handles routing and delivery.
The dashboard itself does not run a background threshold evaluator.

The output never embeds a dashboard token. With native `METRICS_AUTH=true`,
provide a valid Bunqueue `AUTH_TOKENS` bearer token through the indicated file
on the Prometheus host. Encoded path separators, ambiguous reserved characters and
malformed/control-character escapes are rejected because Prometheus cannot preserve their path semantics.
Native **Webhooks** delivers configured job events
from the broker. Existing **Alerts** are local browser rules that require an
open tab. These three mechanisms have different execution scopes.

Bunqueue's access model uses bearer tokens. Identity, user roles and a
user-attributed audit trail require external infrastructure and are not exposed
as native dashboard management features.
