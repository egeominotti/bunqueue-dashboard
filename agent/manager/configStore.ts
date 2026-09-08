import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { copyConfig, validateServerConfig } from './config';
import type { ServerConfig } from './types';

export interface ConfigStore {
  load(fallback: ServerConfig): ServerConfig;
  save(config: ServerConfig): void;
}

const MAX_CONFIG_BYTES = 1024 * 1024;

/** Private atomic snapshots. Errors never include configuration secrets. */
export class FileConfigStore implements ConfigStore {
  constructor(readonly path: string) {}

  load(fallback: ServerConfig): ServerConfig {
    let descriptor: number;
    try {
      descriptor = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return copyConfig(fallback);
      throw new Error('Cannot read saved agent configuration');
    }
    try {
      if (fstatSync(descriptor).size > MAX_CONFIG_BYTES) throw new Error('oversize');
      const raw = readFileSync(descriptor);
      if (raw.byteLength > MAX_CONFIG_BYTES) throw new Error('oversize');
      const saved = JSON.parse(raw.toString()) as { version?: unknown; config?: unknown };
      if (saved?.version !== 1) throw new Error('unsupported format');
      return copyConfig(validateServerConfig(saved.config));
    } catch {
      throw new Error('Saved agent configuration is invalid; repair or remove AGENT_CONFIG_PATH before restarting');
    } finally {
      closeSync(descriptor);
    }
  }

  save(config: ServerConfig): void {
    const content = JSON.stringify({ version: 1, config: validateServerConfig(config) }) + '\n';
    if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) throw new Error('Agent configuration exceeds 1 MiB');
    const directory = dirname(this.path);
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, content);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.path);
    } catch {
      throw new Error('Cannot persist agent configuration; the change was not applied');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { force: true });
    }
  }
}

/** Paths resolve against the launch directory, just like the database path. Use one path per agent. */
export function agentConfigStore(env: NodeJS.ProcessEnv = process.env): FileConfigStore {
  return new FileConfigStore(resolve(env.AGENT_CONFIG_PATH || '.bunqueue-dashboard/config.json'));
}
