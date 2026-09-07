---
title: Bulk Add Jobs
description: Import distinct jobs from a JSON array, NDJSON, or a file into one Bunqueue queue.
---

# Bulk Add Jobs

Open **Bulk Add Jobs** at `/jobs/bulk-add`. Choose a queue and paste a JSON array or
newline-delimited JSON, or load a file. This screen imports distinct jobs; use
[Add Job](/guide/add-job) to submit one job or repeat a single payload.

## Import

1. Choose the input mode. **spec** accepts job options alongside `data`;
   **raw** treats each entry as the job's data.
2. Paste or load your input. The preview reports the parsed job count and any
   validation error before submission.
3. Select an existing queue or enter a new queue name. Set optional default
   priority, attempts, backoff and timeout values.
4. Submit and inspect the accepted count, then open [Jobs Explorer](/guide/jobs)
   for that queue to inspect the stored jobs.

Example job specs:

```json
[
  { "name": "welcome", "data": { "recipient": "first" }, "priority": 1 },
  { "name": "welcome", "data": { "recipient": "second" }, "delay": 5000 }
]
```

Per-job options override defaults. Malformed JSON, unsupported options, invalid
numbers and unsafe dependency specifications are rejected before the request.
Use [Job Flows](/guide/flows) to construct dependency graphs.

## Limits and results

The form accepts at most **10,000 jobs** and applies **64 MiB** bounds to input
bytes and the serialized request. A reverse proxy or server may impose a smaller
request limit. Split large imports when needed.

The result is based on the returned job IDs, not just HTTP success. Deduplication
can reduce the number of distinct accepted IDs. The dashboard does not
transparently retry imports: after an ambiguous network failure, inspect the
queue before submitting again.

The browser suite imports two distinct jobs through this page and independently
reads their queue count from the real broker. Validation and response-contract
tests cover malformed inputs, limits and stale server selections. See
[Testing & verification](/testing) for the full scope.
