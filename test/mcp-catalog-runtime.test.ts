import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCP_TOOL_NAMES } from '../src/pages/control/mcp/catalog';

test('MCP setup catalog names every tool advertised by the pinned public executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-mcp-catalog-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('node_modules/bunqueue/dist/mcp/index.js')],
    env: { PATH: process.env.PATH ?? '', DATA_PATH: join(root, 'queue.db') },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'dashboard-catalog-regression', version: '1' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(79);
    expect([...MCP_TOOL_NAMES].sort()).toEqual(tools.tools.map((tool) => tool.name).sort());
    expect(new Set(MCP_TOOL_NAMES).size).toBe(79);
  } finally {
    await client.close();
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
