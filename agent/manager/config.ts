import type { ServerConfig } from './types';

const CONFIG_KEYS = new Set<keyof ServerConfig>([
  'command',
  'httpPort',
  'tcpPort',
  'dataPath',
  'extraEnv',
]);

export function defaultConfig(): ServerConfig {
  return {
    command: process.env.BUNQUEUE_START_CMD || 'bunx bunqueue@2.9.4 start',
    httpPort: Number(process.env.HTTP_PORT) || 6790,
    tcpPort: Number(process.env.TCP_PORT) || 6789,
    dataPath: process.env.BUNQUEUE_DATA_PATH || './data/bunq.db',
    extraEnv: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validatePort(name: 'httpPort' | 'tcpPort', value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

/** Validate an untrusted PUT /control/config body before merging any field. */
export function validateConfigPatch(value: unknown): Partial<ServerConfig> {
  if (!isRecord(value)) throw new Error('Config must be an object');
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key as keyof ServerConfig)) {
      throw new Error(`Unknown config key: ${key}`);
    }
  }

  const patch: Partial<ServerConfig> = {};
  if (Object.hasOwn(value, 'command')) {
    if (typeof value.command !== 'string' || value.command.trim() === '') {
      throw new Error('command must be a non-empty string');
    }
    patch.command = value.command;
  }
  if (Object.hasOwn(value, 'httpPort')) {
    patch.httpPort = validatePort('httpPort', value.httpPort);
  }
  if (Object.hasOwn(value, 'tcpPort')) {
    patch.tcpPort = validatePort('tcpPort', value.tcpPort);
  }
  if (Object.hasOwn(value, 'dataPath')) {
    if (typeof value.dataPath !== 'string') throw new Error('dataPath must be a string');
    patch.dataPath = value.dataPath;
  }
  if (Object.hasOwn(value, 'extraEnv')) {
    if (!isRecord(value.extraEnv)) {
      throw new Error('extraEnv must be an object containing only string values');
    }
    const entries = Object.entries(value.extraEnv);
    for (const [key, entry] of entries) {
      if (typeof entry !== 'string') throw new Error(`extraEnv.${key} must be a string`);
    }
    patch.extraEnv = Object.fromEntries(entries) as Record<string, string>;
  }
  return patch;
}

export function validateServerConfig(value: unknown): ServerConfig {
  if (!isRecord(value)) throw new Error('Config must be an object');
  const config = validateConfigPatch(value);
  for (const key of CONFIG_KEYS) {
    if (!Object.hasOwn(value, key)) throw new Error(`Missing config key: ${key}`);
  }
  if (config.httpPort === config.tcpPort) throw new Error('httpPort and tcpPort must differ');
  return config as ServerConfig;
}

export function copyConfig(config: ServerConfig): ServerConfig {
  return { ...config, extraEnv: { ...config.extraEnv } };
}
