import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { formatLogEntry } from '../agent/logger';

describe('agent logger serialization boundary', () => {
  test('emits valid NDJSON for BigInt and cycles', async () => {
    const line = await captureChild(`
      const value = { bigint: 1n };
      value.self = value;
      logger.error(value, 'cyclic context');
    `);

    expect(line).toMatchObject({ level: 50, msg: 'cyclic context', bigint: '1' });
    expect(typeof line.time).toBe('number');
  });

  test('root toJSON and reserved fields cannot forge the NDJSON envelope', async () => {
    const line = await captureChild(`
      const value = new Proxy({
        level: 5,
        time: 0,
        msg: 'forged',
        source: 'operator',
        toJSON: () => ({ level: 5, msg: 'forged' })
      }, {});
      logger.error(value, 'real message');
    `);

    expect(line).toMatchObject({
      level: 50,
      msg: 'real message',
      source: 'operator',
      logSerializationError: '[Unsafe log fields omitted]',
    });
    expect(typeof line.time).toBe('number');
  });

  test('hostile serialization and Proxy traps retain the genuine envelope', async () => {
    const scripts = [
      `const value = { nested: { toJSON() { throw new Error('serialization exploded'); } } };`,
      `const value = new Proxy({}, { ownKeys() { throw new Error('enumeration exploded'); } });`,
    ];
    for (const setup of scripts) {
      const line = await captureChild(`${setup}\nlogger.error(value, 'hostile context');`);
      expect(line).toMatchObject({
        level: 50,
        msg: 'hostile context',
        logSerializationError: '[Unserializable log fields]',
      });
      expect(typeof line.time).toBe('number');
    }
  });

  test('formats hostile values safely for an interactive terminal', () => {
    const value = {
      level: 5,
      msg: 'forged',
      source: 'operator',
      nested: {
        toJSON: () => {
          throw new Error('serialization exploded');
        },
      },
    };

    const line = formatLogEntry('error', value, 'real message', true);

    expect(line).toContain('ERROR');
    expect(line).toContain('real message');
    expect(line).toContain('[Unserializable log fields]');
    expect(line).not.toContain('forged');
  });
});

async function captureChild(script: string): Promise<Record<string, unknown>> {
  const child = Bun.spawn(
    [process.execPath, '-e', `import { logger } from './agent/logger.ts';\n${script}`],
    {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, LOG_LEVEL: 'trace' },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe('');
  const lines = stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? '') as Record<string, unknown>;
}
