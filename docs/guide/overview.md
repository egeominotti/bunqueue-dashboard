---
title: Overview
description: "A single screen that shows, at a glance, whether your bunqueue server is healthy and what your queues are doing right now."
---

# Overview

A single screen that shows, at a glance, whether your bunqueue server is healthy and what your queues are doing right now.

**Where:** Home (the landing page).

![Overview](../screenshots/overview.png)

## What you'll see

At the top, a wide banner tells you if the dashboard is connected. Below it are two rows of headline numbers, a grid of your busiest queues, and a live feed of recent job events. Everything updates on its own, you don't need to refresh.

**Connection banner**

| State | What it means |
| --- | --- |
| Green dot · "bunqueue server connected" · **Online** | The latest check reached the server; the numbers are fresh. |
| Amber dot · "Connection lost, showing last known data" · **Stale** | The latest check failed; you're seeing the last numbers received, which may be a little old. |

The line under the banner always shows the server address, how long it's been running (uptime), and how much memory it's using.

**Headline numbers (first row)**

| Element | What it tells you |
| --- | --- |
| Completed | Total jobs finished successfully over the server's lifetime. |
| Failed | Total jobs that failed. Turns red when above zero. |
| Waiting | Jobs currently queued, waiting to run. |
| Active | Jobs being processed right now. |
| Error Rate | Failed jobs as a share of the total. Turns red above 5%. |
| DLQ | Jobs in the dead-letter queue. Turns red when above zero. |

**Throughput and capacity (second row)**

| Element | What it tells you |
| --- | --- |
| Push/sec | Jobs being added per second. |
| Pull/sec | Jobs being pulled for processing per second. |
| Queues | How many queues exist, with the number of active cron schedules. |
| Total Pushed | Total jobs ever added. |
| API Keys | Whether *this dashboard* has an auth token set (1) or not (0). |
| Uptime | How long the server has been running, with its memory use. |

**Queue Health**, cards for your first six queues. Each shows the queue name, an **active** or **paused** badge, and four counts: **W**aiting, **A**ctive, **C**ompleted, **F**ailed. A dash (, ) means that count isn't available yet.

**Recent Activity**, a live feed of the last few job events, each with a colored status dot, the queue, a short job ID, the status, and how long ago it happened.

## What you can do

This screen is for watching, not changing, there are no destructive actions here. You can:

- **Open a queue**, click any Queue Health card to jump into that queue's details.
- **See all queues**, click **View All** next to Queue Health.
- **See the full activity log**, click **View All** next to Recent Activity.
- **Reconnect**, when the banner is amber, click **Retry** to check the server again right away.

## Good to know

::: tip
The screen refreshes on its own every few seconds. An amber "Stale" banner means only the *last* check failed, the server may still be up, and your numbers are simply a few seconds old. Click **Retry** to check again.
:::

- **API Keys reflects only this dashboard.** It shows 1 when you've set an auth token here, 0 otherwise. It is not a count of keys on the server.
- **Queue Health shows six queues.** If you have more, use **View All** to see them. The **Queues** number still counts every one.
- **Recent Activity starts empty.** It fills as new events arrive and doesn't load past history. For the full picture, open the activity log via **View All**.
- **A dash (, ) means "not available yet,"** not zero.

For a plain-language list of current limits, see [Known issues](/known-issues).

::: details Under the hood (for developers)
- Uses the shape-verified `bq` client plus a shared activity-stream hook.
- Polls two endpoints together, `GET /dashboard` and `GET /queues/summary`, on the global refresh interval (default 3000 ms), with at most one request in flight.
- Live events come from the `/events` SSE stream (250-event ring buffer, ~150 ms flush, 2000 ms reconnect backoff).
- Deliberately two requests per poll, not one-per-queue: `/queues/summary` already carries every queue's counts.
:::
