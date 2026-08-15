import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { isIgnoredDirectory } from '../scripts/check-implicit-any-let';

const ROOT = resolve(import.meta.dir, '..');
const OXLINT = resolve(ROOT, 'node_modules/.bin/oxlint');
const FIXTURES = 'test/fixtures/oxlint-policy';
const PROBE_CONFIG = `${FIXTURES}/oxlint-probe.json`;
const TSCONFIG = `${FIXTURES}/tsconfig.json`;

describe('Oxc policy parity', () => {
  test('promotes the complete recommended correctness category to blocking errors', async () => {
    const result = await run([OXLINT, '--print-config']);
    const config = JSON.parse(result.output) as {
      categories: Record<string, string>;
      rules: Record<string, string | unknown[]>;
    };

    expect(result.exitCode).toBe(0);
    expect(config.categories.correctness).toBe('deny');
    expect(config.rules['constructor-super']).toBe('deny');
    expect(config.rules['no-dupe-keys']).toBe('deny');
    expect(config.rules['no-unreachable']).toBe('deny');
    expect(config.rules['no-unsafe-optional-chaining']).toBe('deny');
    expect(config.rules['react/exhaustive-deps']).toBe('warn');
    expect(config.rules['typescript/no-floating-promises']).toBe('allow');
  });

  test('rejects the former Biome error rules, including type-aware rules', async () => {
    const result = await run([
      OXLINT,
      `--config=${PROBE_CONFIG}`,
      `--tsconfig=${TSCONFIG}`,
      `${FIXTURES}/errors.ts`,
    ]);

    expect(result.exitCode).not.toBe(0);
    for (const rule of [
      'no-debugger',
      'no-else-return',
      'no-dupe-keys',
      'no-unreachable',
      'no-unsafe-optional-chaining',
      'prefer-optional-chain',
      'consistent-type-exports',
    ]) {
      expect(result.output).toContain(rule);
    }
  });

  test('keeps warnings non-blocking and policy fixtures ignored by the project lint', async () => {
    const warning = await run([
      OXLINT,
      `--config=${PROBE_CONFIG}`,
      `--tsconfig=${TSCONFIG}`,
      `${FIXTURES}/warning.tsx`,
    ]);
    expect(warning.exitCode).toBe(0);
    expect(warning.output).toContain('no-array-index-key');

    const ignored = await run([OXLINT, '--no-error-on-unmatched-pattern', `${FIXTURES}/errors.ts`]);
    expect(ignored.exitCode).toBe(0);
    expect(ignored.output).not.toContain('no-debugger');
  });

  test('rejects stale disable directives', async () => {
    const result = await run([
      OXLINT,
      `--config=${PROBE_CONFIG}`,
      `--tsconfig=${TSCONFIG}`,
      `${FIXTURES}/unused-disable.ts`,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.output.toLowerCase()).toContain('unused oxlint-disable directive');
  });

  test('retains noImplicitAnyLet coverage missing from Oxlint', async () => {
    const invalid = await run([
      process.execPath,
      'run',
      'scripts/check-implicit-any-let.ts',
      `${FIXTURES}/implicit-any.ts`,
    ]);
    const valid = await run([
      process.execPath,
      'run',
      'scripts/check-implicit-any-let.ts',
      `${FIXTURES}/valid.ts`,
    ]);

    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.output).toContain('Implicit any variable declarations are forbidden');
    expect(valid.exitCode).toBe(0);
  });

  test('keeps ignored directory matching portable across path separators', () => {
    expect(isIgnoredDirectory('test/fixtures/oxlint-policy')).toBe(true);
    expect(isIgnoredDirectory('test\\fixtures\\oxlint-policy')).toBe(true);
    expect(isIgnoredDirectory('docs/.vitepress/theme')).toBe(true);
    expect(isIgnoredDirectory('docs\\.vitepress\\theme')).toBe(true);
    expect(isIgnoredDirectory('test/fixtures/oxlint-policy-neighbor')).toBe(false);
  });
});

async function run(command: string[]): Promise<{ exitCode: number; output: string }> {
  const process = Bun.spawn({
    cmd: command,
    cwd: ROOT,
    env: { ...Bun.env, NO_COLOR: '1' },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}
