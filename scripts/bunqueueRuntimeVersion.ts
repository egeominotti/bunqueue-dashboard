import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repository = resolve(import.meta.dir, '..');
const manifest = JSON.parse(readFileSync(resolve(repository, 'package.json'), 'utf8'));
const installed = JSON.parse(
  readFileSync(resolve(repository, 'node_modules/bunqueue/package.json'), 'utf8')
);

export const installedBunqueueVersion: string = installed.version;

export function verifyBunqueueVersion(actual: unknown, expected: string): string {
  if (typeof actual !== 'string' || actual !== expected) {
    throw new Error(`Bunqueue version mismatch: expected ${expected}, received ${String(actual)}`);
  }
  return actual;
}

/** Validate the actual server, not a label embedded in the test script. */
export async function assertBunqueueRuntimeVersion(
  httpPort: number,
  token?: string,
  expected = installedBunqueueVersion
): Promise<string> {
  verifyBunqueueVersion(installedBunqueueVersion, manifest.dependencies.bunqueue);
  const response = await fetch(`http://127.0.0.1:${httpPort}/health`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Bunqueue version probe failed: HTTP ${response.status}`);
  const health = (await response.json()) as { version?: unknown };
  return verifyBunqueueVersion(health.version, expected);
}
