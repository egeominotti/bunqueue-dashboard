---
title: Workflow Engine
description: Inspect Bunqueue Workflow Engine executions, durable decisions, signals, nested runs, and saga compensation.
---

# Workflow Engine

**Where:** use the dedicated **Workflow** sidebar section.

- **Overview** (`/workflows`) is the command-center view.
- **Job Flows** (`/flows`) renders parent/child and dependency DAGs.
- **Executions** (`/workflows/executions`) browses the active store.
- **Waiting & Signals** (`/workflows/waiting`) isolates parked executions.
- **Compensation** (`/workflows/compensation`) combines `compensating` and
  `compensation-stuck` runs and exposes every per-step rollback outcome.
- **Archive** (`/workflows/archive`) audits retained terminal executions.

The Workflow Engine page reads Bunqueue 2.8.57's persisted execution contract
from the configured SQLite `dataPath`. It shows active and archived executions,
exact workflow/state filters, durable step progress, attempts, results,
idempotency keys, loop occurrences, signals, branch decisions, definition
identity, parent/child executions, pivot state, failure reasons, and every saga
compensation outcome.

The control agent opens SQLite read-only and decodes the Engine's official
structured-clone MessagePack blobs. List responses contain bounded summaries;
the selected execution is decoded separately with explicit blob, depth, node,
and string limits. An absent `workflow_executions` table is shown as an
uninitialized store rather than as a broken page.

## Why controls are read-only

Bunqueue 2.8.57 does not expose Workflow Engine mutations through its HTTP
server. `start`, `signal`, `recover`, `resumeCompensation`, and
`abandonCompensation` operate on the live `Engine` instance, which owns the
registered workflow definitions and handlers. Editing SQLite rows or enqueueing
internal `__wf:steps` jobs would bypass those invariants, so the dashboard does
not present unsafe imitation controls.

Use the application's own authenticated operator endpoint when it needs remote
workflow control. The dashboard can add such controls once that endpoint has an
explicit contract and authorization model.
