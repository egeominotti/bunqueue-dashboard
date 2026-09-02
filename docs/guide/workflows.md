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

The Workflow Engine page reads Bunqueue 2.9.3's persisted execution contract
from the configured SQLite `dataPath`. It shows active and archived executions,
exact workflow/state filters, durable step progress, attempts, results,
idempotency keys, loop occurrences, signals, branch decisions, definition
identity, parent/child executions, pivot state, failure reasons, and every saga
compensation outcome.

The control agent opens SQLite read-only for observability and decodes the
Engine's official structured-clone MessagePack blobs. List responses contain
bounded summaries; the selected execution is decoded separately with explicit
blob, depth, node, and string limits. An absent `workflow_executions` table is
shown as an uninitialized store rather than as a broken page.

Filters, active/archive store, page offset, selected execution, and the
Summary/History/Payloads tab are encoded in the URL. Copying the address or
using Back/Forward therefore restores the same operator context; incompatible
or malformed parameters are removed before any request is issued.

## Connect the live Engine

Workflow handlers are application code, so the dashboard never fabricates them
or edits SQLite. Put their absolute module path in
`BUNQUEUE_WORKFLOW_MODULE` under **Server → Extra environment**, then start the
managed Bunqueue server. The module can export either:

- `workflows`, an array of official Bunqueue `Workflow` definitions; or
- `registerWorkflowRuntime(engine)` (or a default function) that registers the
  definitions and handlers on the supplied `Engine`.

An optional `workflowNames` string array lets callback-style modules populate
the start-execution suggestions. Registrations performed inside the callback are
also discovered automatically. `BUNQUEUE_WORKFLOW_QUEUE_NAME` selects the
Engine's internal step queue (default `__wf:steps`) and
`BUNQUEUE_WORKFLOW_CONCURRENCY` sets worker concurrency from 1 to 1000 (default
`5`). The runtime panel reports both effective values. The agent creates one
persistent official `Engine` against the managed TCP port and `dataPath`,
serializes commands, and closes it before server stop/restart. **Reload
definitions** re-imports the module and replaces the Engine cleanly.

## Operator controls

- **Overview** starts a named workflow with JSON input, recovers orphaned
  executions, reloads definitions, and shows the authoritative command result.
- **Waiting & Signals** sends an exact durable event name and optional JSON
  payload to the selected waiting execution.
- **Compensation** resumes a stuck unwind or explicitly abandons its remaining
  compensations after confirmation.
- **Archive** can move `completed`/`failed` executions older than the chosen
  age into retention. Its separate cleanup action permanently deletes only
  eligible terminal rows still in the active execution store; it never deletes
  archive records, and the confirmation states that boundary explicitly.

Every command is pinned to the Bunqueue target managed by the local agent. A
remote/mismatched target, stopped server, missing module, malformed body, or
non-terminal maintenance request fails closed. When `AGENT_TOKEN` is set, the
normal agent bearer-token policy applies to every mutation.
