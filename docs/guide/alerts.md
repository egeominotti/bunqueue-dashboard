---
title: Alerts
description: Create browser-local threshold rules, inspect triggered alerts and understand delivery limits.
---

# Alerts

Open **Monitoring → Alerts** (`/alerts`) to evaluate thresholds against the connected Bunqueue
server. Rules run in the browser while the dashboard tab is open, including when backgrounded.
Closing the dashboard stops evaluation; this is not a server-side monitoring service.

## Create and verify a rule

1. Select **Create Alert Rule** and enter a descriptive name.
2. Choose the metric, comparison operator and threshold. Count metrics use whole jobs;
   error rate uses a percentage. P99 latency is global and cannot be scoped to a queue.
3. Optionally select a queue by entering its exact name, then select **Save rule**.
4. Check **Triggered Alerts** for the measured value, condition and queue. Enable or disable
   the rule in **Alert Rules**, or delete it after confirmation.

For an isolated test queue containing one waiting job, a `Waiting >= 1` rule should trigger.
The real browser test in `e2e/monitoring.e2e.ts` creates that job, saves the rule, observes the
triggered row and removes the rule. See [Testing & verification](../testing.md).

## Read the state correctly

- **Checking** means a current sample has not arrived yet.
- A metrics error shows an unavailable/degraded state; it must not be treated as an all-clear.
- **No triggered alerts** is meaningful only once enabled rules have current metrics.
- Switching the connection invalidates results from the previous server.

Rules are stored locally in the browser. Breaches produce in-app notifications and, when browser
permission is granted, desktop notifications. Email, Slack and webhook delivery require an
external monitoring service or hosted functionality; the local rule editor does not send them.
