import type { ServerConfig } from '@/lib/bqTypes';

export interface ConfigEditor {
  baseline: ServerConfig;
  id: number;
  revision?: number;
  scope: string;
  value: ServerConfig;
}

export interface ConfigSaveFence {
  accepted: ServerConfig;
  acceptedRevision?: number;
  before: ServerConfig | null;
  beforeRevision?: number;
  ignoreThroughRequestId?: number;
}

export interface ParsedConfigSaveResponse {
  config: ServerConfig;
  revision?: number;
}

export function adoptConfig(
  config: ServerConfig,
  revision: number | undefined,
  scope: string,
  id: number
): ConfigEditor {
  const baseline = copyConfig(config);
  return { baseline, id, revision, scope, value: copyConfig(config) };
}

export function createConfigSaveFence(
  accepted: ServerConfig,
  acceptedRevision: number | undefined,
  before: ServerConfig | null,
  beforeRevision: number | undefined,
  ignoreThroughRequestId?: number
): ConfigSaveFence {
  return {
    accepted: copyConfig(accepted),
    acceptedRevision,
    before: before ? copyConfig(before) : null,
    beforeRevision,
    ignoreThroughRequestId,
  };
}

/** Keep an accepted save authoritative until polling moves past its pre-save snapshot. */
export function shouldIgnoreStatusBehindSave(
  fence: ConfigSaveFence,
  config: ServerConfig,
  revision: number | undefined,
  requestId?: number
): boolean {
  if (sameConfig(config, fence.accepted)) return false;
  if (requestId !== undefined && fence.ignoreThroughRequestId !== undefined) {
    return requestId <= fence.ignoreThroughRequestId;
  }
  if (revision !== undefined) {
    return revision === fence.beforeRevision || revision === fence.acceptedRevision;
  }
  return fence.before !== null && sameConfig(config, fence.before);
}

export function parseConfigSaveResponse(value: unknown): ParsedConfigSaveResponse {
  if (!isRecord(value)) return malformedConfigResponse();
  const { command, httpPort, tcpPort, dataPath, extraEnv } = value;
  if (
    typeof command !== 'string' ||
    command.trim() === '' ||
    !validPort(httpPort) ||
    !validPort(tcpPort) ||
    httpPort === tcpPort ||
    typeof dataPath !== 'string' ||
    !isRecord(extraEnv) ||
    Object.values(extraEnv).some((entry) => typeof entry !== 'string')
  ) {
    return malformedConfigResponse();
  }
  const revision = validConfigRevision(value.configRevision);
  if (value.configRevision !== undefined && revision === undefined) {
    return malformedConfigResponse();
  }
  return {
    config: {
      command,
      httpPort,
      tcpPort,
      dataPath,
      extraEnv: Object.fromEntries(Object.entries(extraEnv)) as Record<string, string>,
    },
    revision,
  };
}

export function validConfigRevision(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function configDraftError(config: ServerConfig): string | null {
  if (!validPort(config.httpPort)) return 'HTTP port must be an integer between 1 and 65535';
  if (!validPort(config.tcpPort)) return 'TCP port must be an integer between 1 and 65535';
  if (config.httpPort === config.tcpPort) return 'HTTP and TCP ports must differ';
  return null;
}

export function changedConfigFields(running: ServerConfig | null, desired: ServerConfig): string[] {
  if (!running) return [];
  const changed: string[] = [];
  if (running.command !== desired.command) changed.push('command');
  if (running.httpPort !== desired.httpPort) changed.push('HTTP port');
  if (running.tcpPort !== desired.tcpPort) changed.push('TCP port');
  if (running.dataPath !== desired.dataPath) changed.push('data path');
  if (envKey(running.extraEnv) !== envKey(desired.extraEnv)) {
    changed.push('environment variables');
  }
  return changed;
}

export function sameConfig(left: ServerConfig, right: ServerConfig): boolean {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function copyConfig(config: ServerConfig): ServerConfig {
  return { ...config, extraEnv: { ...config.extraEnv } };
}

function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function malformedConfigResponse(): never {
  throw new Error('Configuration save returned a malformed response');
}

function envKey(value: Record<string, string>): string {
  return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function normalize(config: ServerConfig) {
  return {
    ...config,
    extraEnv: Object.fromEntries(
      Object.entries(config.extraEnv).sort(([a], [b]) => a.localeCompare(b))
    ),
  };
}
