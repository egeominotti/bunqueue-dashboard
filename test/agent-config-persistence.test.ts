import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProcessManager } from '../agent/manager';
import { defaultConfig } from '../agent/manager/config';
import { agentConfigStore, FileConfigStore } from '../agent/manager/configStore';

const directories: string[] = [];
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), 'bq-config-test-'));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('durable agent configuration', () => {
  test('survives manager recreation without starting the server or reusing revisions', () => {
    const path = join(scratch(), 'private/config.json');
    const manager = new ProcessManager(undefined, new FileConfigStore(path));
    const saved = manager.setConfig({
      command: 'bun custom.ts',
      dataPath: 'other.db',
      extraEnv: { STORAGE: 'sqlite', TOKEN: 'private-value' },
    });
    const restarted = new ProcessManager(undefined, new FileConfigStore(path));
    expect(restarted.getConfig()).toEqual(saved);
    expect(restarted.getStatus()).toMatchObject({
      status: 'stopped',
      pid: null,
      runningConfig: null,
    });
    expect(restarted.getConfigRevision()).not.toBe(manager.getConfigRevision());
    expect(() =>
      restarted.setConfig({ dataPath: 'stale.db' }, manager.getConfigRevision())
    ).toThrow('Configuration changed');
    saved.extraEnv.TOKEN = 'changed-copy';
    expect(restarted.getConfig().extraEnv.TOKEN).toBe('private-value');
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(join(path, '..'))).toEqual(['config.json']);
  });

  test('a failed save leaves both in-memory configuration and revision unchanged', () => {
    const directory = scratch();
    const path = join(directory, 'config.json');
    const manager = new ProcessManager(undefined, new FileConfigStore(path));
    const before = manager.getConfig();
    const revision = manager.getConfigRevision();
    mkdirSync(path); // Atomically replacing a directory must fail on every OS.
    expect(() => manager.setConfig({ dataPath: 'new.db' })).toThrow('Cannot persist');
    expect(manager.getConfig()).toEqual(before);
    expect(manager.getConfigRevision()).toBe(revision);
    expect(readdirSync(directory)).toEqual(['config.json']);
  });

  test('invalid or oversized input never replaces the last valid snapshot', () => {
    const path = join(scratch(), 'config.json');
    const manager = new ProcessManager(undefined, new FileConfigStore(path));
    manager.setConfig({ dataPath: 'persisted.db' });
    const original = readFileSync(path, 'utf8');
    expect(() => manager.setConfig({ httpPort: -1 })).toThrow();
    expect(() => manager.setConfig({ extraEnv: { LARGE: 'x'.repeat(1024 * 1024) } })).toThrow(
      'exceeds 1 MiB'
    );
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  test('corrupt, incomplete and unsupported snapshots fail startup without revealing content', () => {
    const path = join(scratch(), 'config.json');
    for (const content of [
      'secret-not-json',
      'null',
      '{"version":2}',
      '{"version":1,"config":{}}',
      'x'.repeat(1024 * 1024 + 1),
    ]) {
      writeFileSync(path, content);
      expect(() => new FileConfigStore(path).load(defaultConfig())).toThrow(
        'Saved agent configuration is invalid'
      );
    }
  });

  test('load errors fail closed; missing files use independent copies of defaults', () => {
    const path = join(scratch(), 'config.json');
    const fallback = defaultConfig();
    const loaded = new FileConfigStore(path).load(fallback);
    loaded.extraEnv.TEST = 'value';
    expect(fallback.extraEnv.TEST).toBeUndefined();
    if (process.platform !== 'win32') {
      symlinkSync(path, path);
      expect(() => new FileConfigStore(path).load(fallback)).toThrow('Cannot read');
    }
    expect(agentConfigStore({ AGENT_CONFIG_PATH: path }).path).toBe(path);
    expect(agentConfigStore({}).path).toBe(resolve('.bunqueue-dashboard/config.json'));
  });
});
