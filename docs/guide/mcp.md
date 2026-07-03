---
title: MCP Server
description: Connect bunqueue to AI agents (Claude Desktop, Claude Code) over the Model Context Protocol, with 73 tools, 5 resources, and 3 prompts, in embedded or TCP mode.
---

# MCP Server

bunqueue ships a Model Context Protocol server, `bunqueue-mcp`, that lets an AI
agent (Claude Desktop, Claude Code) drive the queue with tools, resources, and
prompts.

It is a separate **stdio** process, launched by the MCP client rather than by
this dashboard, and it is not part of the HTTP API on `:6790`. That is why the
dashboard's **MCP** page (and this guide) is a setup and reference, not a live
monitor. The server needs the optional peer dependency
`@modelcontextprotocol/sdk`.

## Connection modes

### Embedded (default)

Direct SQLite access, with no running server. Point `DATA_PATH` at the bunqueue
database file. Best for a local agent on the same machine.

```json
{
  "mcpServers": {
    "bunqueue": {
      "command": "bunx",
      "args": ["--package=bunqueue", "bunqueue-mcp"],
      "env": { "DATA_PATH": "./data/bunq.db" }
    }
  }
}
```

### TCP (remote server)

Connect to a running bunqueue server over its TCP protocol port (`6789`, distinct
from the HTTP admin API on `6790`). Use `BUNQUEUE_TOKEN` if the server has one.

```json
{
  "mcpServers": {
    "bunqueue": {
      "command": "bunx",
      "args": ["--package=bunqueue", "bunqueue-mcp"],
      "env": {
        "BUNQUEUE_MODE": "tcp",
        "BUNQUEUE_HOST": "localhost",
        "BUNQUEUE_PORT": "6789",
        "BUNQUEUE_TOKEN": "your-token"
      }
    }
  }
}
```

## Where to put it

For **Claude Desktop**, add the JSON above to `claude_desktop_config.json`. For
**Claude Code**, register it from the CLI:

```bash
claude mcp add bunqueue -- bunx --package=bunqueue bunqueue-mcp
```

## What it exposes

### Tools (73, in 12 categories)

Every tool name is prefixed `bunqueue_`; the examples below drop the prefix.

| Category | Count | Examples |
| --- | --- | --- |
| Jobs | 11 | `add_job`, `get_job`, `get_jobs`, `get_job_result`, `wait_for_job` |
| Job management | 6 | `cancel_job`, `change_job_priority`, `promote_job`, `update_job_data` |
| Consumption | 8 | `pull_job`, `pull_job_batch`, `ack_job`, `fail_job`, `job_heartbeat` |
| Queues | 11 | `list_queues`, `pause_queue`, `resume_queue`, `drain_queue`, `obliterate_queue` |
| Dead letter queue | 4 | `get_dlq`, `retry_dlq`, `purge_dlq` |
| Cron | 4 | `add_cron`, `list_crons`, `get_cron`, `delete_cron` |
| Flows | 4 | `add_flow`, `add_flow_chain`, `get_flow`, `get_children_values` |
| Rate limits | 4 | `set_rate_limit`, `set_concurrency`, `clear_rate_limit` |
| Webhooks | 4 | `add_webhook`, `list_webhooks`, `remove_webhook`, `set_webhook_enabled` |
| Workers | 3 | `register_worker`, `list_workers`, `worker_heartbeat` |
| Handlers | 3 | `register_handler`, `list_handlers`, `unregister_handler` |
| Monitoring | 11 | `get_stats`, `get_queue_stats`, `get_memory_stats`, `get_prometheus_metrics` |

### Resources (5)

`bunqueue://queues`, `bunqueue://stats`, `bunqueue://workers`, `bunqueue://crons`,
`bunqueue://webhooks`.

### Prompts (3)

`bunqueue_debug_queue`, `bunqueue_health_report`, `bunqueue_incident_response`.
