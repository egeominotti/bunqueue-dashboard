import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import type { ConnectionOptions } from 'bunqueue/client';
import type { ServerConfig } from './manager';
import { managedAuthToken } from './managedTarget';

/** Same environment precedence as the managed child; never disables verification. */
export function managedConnection(config: ServerConfig): ConnectionOptions {
  const env = (key: string) =>
    (Object.hasOwn(config.extraEnv, key) ? config.extraEnv[key] : process.env[key])?.trim();
  const mode = env('BUNQUEUE_AGENT_TCP_TLS');
  if (mode && mode !== 'true' && mode !== 'false') {
    throw new Error('BUNQUEUE_AGENT_TCP_TLS must be true or false.');
  }
  const caFile = env('BUNQUEUE_AGENT_TCP_CA_FILE');
  const serverTls = Boolean(env('TLS_CERT_FILE') || env('TLS_KEY_FILE'));
  if (mode === 'false' && (serverTls || caFile)) {
    throw new Error('Cannot disable agent TCP TLS when server TLS or a CA is configured.');
  }
  if (caFile) {
    if (!isAbsolute(caFile)) throw new Error('BUNQUEUE_AGENT_TCP_CA_FILE must be absolute.');
    try {
      if (!statSync(caFile).isFile()) throw new Error();
    } catch {
      throw new Error('BUNQUEUE_AGENT_TCP_CA_FILE must point to a readable CA file.');
    }
  }
  const tls = mode === 'true' || serverTls || Boolean(caFile);
  return {
    host: '127.0.0.1',
    port: config.tcpPort,
    token: managedAuthToken(config),
    ...(tls ? { tls: { rejectUnauthorized: true, ...(caFile ? { caFile } : {}) } } : {}),
  };
}
