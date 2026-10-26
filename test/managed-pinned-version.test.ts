import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../agent/manager/config';
import { FileConfigStore } from '../agent/manager/configStore';
import manifest from '../package.json';
import { demoApiResponse } from '../src/lib/demo/api';
import { DEMO_CONFIG, demoControlLogs, demoStatus } from '../src/lib/demo/control';

const pinned = manifest.dependencies.bunqueue;

test('managed defaults use the manifest pin while environment and saved commands keep precedence', () => {
  const previous = process.env.BUNQUEUE_START_CMD;
  const root = mkdtempSync(join(tmpdir(), 'managed-pin-'));
  try {
    delete process.env.BUNQUEUE_START_CMD;
    expect(defaultConfig().command).toBe(`bunx bunqueue@${pinned} start`);
    process.env.BUNQUEUE_START_CMD = 'bunx bunqueue@2.9.2 start';
    expect(defaultConfig().command).toBe('bunx bunqueue@2.9.2 start');
    const store = new FileConfigStore(join(root, 'config.json'));
    store.save({ ...defaultConfig(), command: 'bun custom-server.ts' });
    expect(store.load(defaultConfig()).command).toBe('bun custom-server.ts');
  } finally {
    if (previous === undefined) delete process.env.BUNQUEUE_START_CMD;
    else process.env.BUNQUEUE_START_CMD = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('demo health, managed status, command and logs present the same pinned release', () => {
  expect(demoApiResponse('/health', 'GET', '')).toMatchObject({ version: pinned });
  expect(demoStatus()).toMatchObject({ version: pinned });
  expect(DEMO_CONFIG.command).toBe(`bunx bunqueue@${pinned} start`);
  const logs = demoControlLogs() as { lines: { line: string }[] };
  expect(logs.lines[0].line).toBe(`starting: bunx bunqueue@${pinned} start`);
  expect(logs.lines[1].line).toContain(`bunqueue v${pinned}`);
});
