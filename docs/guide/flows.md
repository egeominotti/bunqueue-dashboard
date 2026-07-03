---
title: Flows
description: Visualize a bunqueue job flow as an interactive DAG in the dashboard, parent, children, and dependency edges, coloured by state.
---

# Flows

The **Flows** page draws a job flow as an interactive graph, so you can see how a
parent job fans out to its children and which jobs depend on which.

## How it works

bunqueue has no single "get the whole flow" HTTP endpoint, so the dashboard
builds the graph on the client from each job's own fields (`childrenIds`,
`dependsOn`, `parentId`):

1. Paste any job ID, or open a job that is part of a flow in the
   [Job Inspector](/guide/job-inspector) and choose **View flow**.
2. The page climbs `parentId` to the flow's root.
3. From the root it walks `childrenIds` (solid edges) and `dependsOn` (dashed
   edges), up to 60 nodes.
4. It lays the graph out in columns by dependency depth and colours every node by
   state: completed, active, failed, waiting, or delayed.

Click any node to inspect it in the side panel, or open it in the Job Inspector.
The whole graph is computed and rendered in the browser, with no graph library
and no extra server endpoint.

## Try it

The [live demo](https://egeominotti.github.io/bunqueue-dashboard/) ships a sample
flow (an order that fans out to charge, ship, and notify, with a shipping-label
child and a notify-depends-on-charge edge), so the page is populated out of the
box.
