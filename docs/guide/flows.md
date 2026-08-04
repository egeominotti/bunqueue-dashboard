---
title: Flows
description: Visualize a bunqueue job flow as an interactive DAG in the dashboard, parent, children, and dependency edges, coloured by state.
---

# Flows

The **Flows** page draws a job flow as an interactive graph, so you can see how a
parent job owns its children and which jobs depend on which. In Bunqueue flows,
children run before their parent.

## How it works

bunqueue has no single "get the whole flow" HTTP endpoint, so the dashboard
builds the graph on the client from each job's own fields (`childrenIds`,
`dependsOn`, `parentId`):

1. Paste any job ID, or open a job that is part of a flow in the
   [Job Inspector](/guide/job-inspector) and choose **View flow**.
2. The page climbs `parentId` to the flow's root, following up to the 100 levels
   supported by the v2.8.57 flow planner.
3. From the root it walks `childrenIds` (solid edges) and non-structural
   `dependsOn` links (dashed edges), up to 500 nodes.
4. It lays the graph out in columns by dependency depth and colours every node by
   state, including `waiting-children` for a parent blocked on its children.

Job IDs must also be addressable by v2.8.57's non-decoding `/jobs/:id` HTTP
route. Path-safe punctuation such as `:`, `@`, and `+` is preserved exactly;
spaces, slashes, percent signs, and the exact dot segments `.` / `..` are
rejected before a request is sent. The same validation is applied to parent,
child, and dependency IDs returned by the server, so malformed topology cannot
be normalized by the browser into a different URL.

Every v2.8.57 job snapshot must explicitly contain all three topology fields:
`parentId` as a string or `null`, plus `childrenIds` and `dependsOn` as arrays.
An absent field is not interpreted as an empty relationship. A partial root or
seed stops the traversal with an error; a partial referenced node is shown as
unavailable with the malformed-field reason.

::: warning Mutations outside this page
Bunqueue v2.8.57 does not expose reverse-dependency inspection or
topology-aware Cancel, Drain, Clean, Obliterate, DLQ Retry, or DLQ Purge.
Deleting a referenced job can strand a parent in `waiting-children`, while a
DLQ retry POST cannot atomically require the generation, state and topology
seen by a prior GET; it can hit a different job recreated under the same ID.
The dashboard therefore disables every manual, bulk and Copilot DLQ retry.
Completed-job requeue is also disabled because `retryCompleted` does not
reconstruct dependency registration or original flow order. Delete/purge paths
fail closed, `maxAge`/`maxEntries` retention is read-only and omitted from DLQ
policy saves, and auto-retry can only be disabled.
:::

v2.8.57 stores every canonical child in both the parent's `childrenIds` and
`dependsOn`. The dashboard collapses that symmetric metadata into one solid
parent-to-child edge; otherwise every normal relationship would be drawn twice
in opposite directions and create an artificial cycle. Dashed edges therefore
represent additional dependency links, such as one sibling waiting for another.

Click any node to inspect it in the side panel, or open it in the Job Inspector.
The whole graph is computed and rendered in the browser, with no graph library
and no extra server endpoint.

The page never hides an incomplete or corrupt graph. It reports traversal caps,
missing/malformed job snapshots, inconsistent parent/child backlinks, and real
dependency cycles next to the graph. Recently viewed roots are stored per
Bunqueue server target, so switching connections cannot surface ids from a
different server. When bearer authentication is active, recent roots remain in
memory only and reset with the credentials; tokens are never persisted or used
as storage keys.

## Try it

The [live demo](https://egeominotti.github.io/bunqueue-dashboard/) ships a sample
flow (an order that fans out to charge, ship, and notify, with a shipping-label
child and a notify-depends-on-charge edge), so the page is populated out of the
box.
