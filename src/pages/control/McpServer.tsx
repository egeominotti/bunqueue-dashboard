import type { ReactNode } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';

/**
 * MCP Server — a setup and reference page for bunqueue's Model Context Protocol
 * server (`bunqueue-mcp`). That server is a separate stdio process that exposes
 * the queue to AI agents (Claude Desktop, Claude Code); it is NOT part of the
 * HTTP API this dashboard drives, and it is launched by the MCP client rather
 * than managed here, so this page is a guide (what it exposes + how to connect
 * it), not a live monitor. All facts are taken from bunqueue 2.8.26.
 */

const EMBEDDED_CONFIG = `{
  "mcpServers": {
    "bunqueue": {
      "command": "bunx",
      "args": ["--package=bunqueue", "bunqueue-mcp"],
      "env": { "DATA_PATH": "./data/bunq.db" }
    }
  }
}`;

const TCP_CONFIG = `{
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
}`;

const CLI_ADD = 'claude mcp add bunqueue -- bunx --package=bunqueue bunqueue-mcp';

type Category = { name: string; count: number; examples: string[] };

// 73 tools across 12 categories (bunqueue 2.8.26). Every tool is prefixed
// `bunqueue_`; examples below drop the prefix for readability.
const CATEGORIES: Category[] = [
  {
    name: 'Jobs',
    count: 11,
    examples: ['add_job', 'get_job', 'get_jobs', 'get_job_result', 'wait_for_job'],
  },
  {
    name: 'Job management',
    count: 6,
    examples: ['cancel_job', 'change_job_priority', 'promote_job', 'update_job_data'],
  },
  {
    name: 'Consumption',
    count: 8,
    examples: ['pull_job', 'pull_job_batch', 'ack_job', 'fail_job', 'job_heartbeat'],
  },
  {
    name: 'Queues',
    count: 11,
    examples: ['list_queues', 'pause_queue', 'resume_queue', 'drain_queue', 'obliterate_queue'],
  },
  { name: 'Dead letter queue', count: 4, examples: ['get_dlq', 'retry_dlq', 'purge_dlq'] },
  { name: 'Cron', count: 4, examples: ['add_cron', 'list_crons', 'get_cron', 'delete_cron'] },
  {
    name: 'Flows',
    count: 4,
    examples: ['add_flow', 'add_flow_chain', 'get_flow', 'get_children_values'],
  },
  {
    name: 'Rate limits',
    count: 4,
    examples: ['set_rate_limit', 'set_concurrency', 'clear_rate_limit'],
  },
  {
    name: 'Webhooks',
    count: 4,
    examples: ['add_webhook', 'list_webhooks', 'remove_webhook', 'set_webhook_enabled'],
  },
  { name: 'Workers', count: 3, examples: ['register_worker', 'list_workers', 'worker_heartbeat'] },
  {
    name: 'Handlers',
    count: 3,
    examples: ['register_handler', 'list_handlers', 'unregister_handler'],
  },
  {
    name: 'Monitoring',
    count: 11,
    examples: ['get_stats', 'get_queue_stats', 'get_memory_stats', 'get_prometheus_metrics'],
  },
];

const RESOURCES = [
  'bunqueue://queues',
  'bunqueue://stats',
  'bunqueue://workers',
  'bunqueue://crons',
  'bunqueue://webhooks',
];

const PROMPTS = ['bunqueue_debug_queue', 'bunqueue_health_report', 'bunqueue_incident_response'];

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      <div className="absolute right-2 top-2">
        <CopyButton value={code} />
      </div>
      <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 p-4 pr-12 font-mono text-xs leading-relaxed text-fg">
        {code}
      </pre>
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">
      {children}
    </span>
  );
}

export function McpServer() {
  return (
    <div>
      <PageHeader
        title="MCP Server"
        description="Connect bunqueue to AI agents (Claude Desktop, Claude Code) over the Model Context Protocol."
        actions={
          <a
            href="https://egeominotti.github.io/bunqueue-dashboard/docs/guide/mcp"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
          >
            Docs
          </a>
        }
      />

      <Card className="mb-6">
        <p className="text-sm leading-relaxed text-muted">
          bunqueue ships a Model Context Protocol server,{' '}
          <span className="font-mono text-fg">bunqueue-mcp</span>, that lets an AI agent drive the
          queue with tools, resources, and prompts. It is a separate{' '}
          <span className="text-fg">stdio</span> process, launched by the MCP client (not by this
          dashboard, and not part of the HTTP API), so this page is a setup and reference guide
          rather than a live monitor. It needs the optional peer dependency{' '}
          <span className="font-mono text-fg">@modelcontextprotocol/sdk</span>.
        </p>
      </Card>

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Tools" value="73" />
        <StatCard label="Categories" value="12" />
        <StatCard label="Resources" value="5" />
        <StatCard label="Prompts" value="3" />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Embedded mode (default)" />
          <p className="mb-3 text-sm text-muted">
            Direct SQLite access, no running server. Point <Chip>DATA_PATH</Chip> at the bunqueue
            database file. Best for a local agent on the same machine.
          </p>
          <CodeBlock code={EMBEDDED_CONFIG} />
        </Card>

        <Card>
          <CardHeader title="TCP mode (remote server)" />
          <p className="mb-3 text-sm text-muted">
            Connect to a running bunqueue server over its TCP protocol port (<Chip>6789</Chip>,
            distinct from the HTTP admin API on 6790). Use a <Chip>BUNQUEUE_TOKEN</Chip> if the
            server has one.
          </p>
          <CodeBlock code={TCP_CONFIG} />
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader title="Where to put it" />
        <p className="mb-3 text-sm text-muted">
          Add the JSON above to your MCP client config (for Claude Desktop, its{' '}
          <span className="font-mono text-fg">claude_desktop_config.json</span>). For Claude Code,
          register it from the CLI:
        </p>
        <CodeBlock code={CLI_ADD} />
      </Card>

      <Card className="mb-6">
        <CardHeader title="Tools" action={<span className="text-xs text-faint">73 total</span>} />
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {CATEGORIES.map((c) => (
            <div key={c.name}>
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-fg">{c.name}</span>
                <span className="text-xs text-faint">{c.count}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {c.examples.map((e) => (
                  <Chip key={e}>{e}</Chip>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-faint">
          Every tool name is prefixed <span className="font-mono">bunqueue_</span> (examples above
          drop it). Counts total 73.
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Resources" action={<span className="text-xs text-faint">5</span>} />
          <div className="flex flex-wrap gap-2">
            {RESOURCES.map((r) => (
              <Chip key={r}>{r}</Chip>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader title="Prompts" action={<span className="text-xs text-faint">3</span>} />
          <div className="flex flex-wrap gap-2">
            {PROMPTS.map((p) => (
              <Chip key={p}>{p}</Chip>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
