import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const OXLINT = [process.execPath, 'x', '--bun', '--no-install', 'oxlint'] as const;
const FIXTURES = 'test/fixtures/oxlint-policy';
const PROBE_CONFIG = `${FIXTURES}/oxlint-probe.json`;
const TSCONFIG = `${FIXTURES}/tsconfig.json`;

describe('Oxc policy parity', () => {
  test('promotes the complete recommended correctness category to blocking errors', async () => {
    const result = await run([...OXLINT, '--print-config']);
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
      ...OXLINT,
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
      ...OXLINT,
      `--config=${PROBE_CONFIG}`,
      `--tsconfig=${TSCONFIG}`,
      `${FIXTURES}/warning.tsx`,
    ]);
    expect(warning.exitCode).toBe(0);
    expect(warning.output).toContain('no-array-index-key');

    const ignored = await run([
      ...OXLINT,
      '--no-error-on-unmatched-pattern',
      `${FIXTURES}/errors.ts`,
    ]);
    expect(ignored.exitCode).toBe(0);
    expect(ignored.output).not.toContain('no-debugger');
  });

  test('rejects stale disable directives', async () => {
    const result = await run([
      ...OXLINT,
      `--config=${PROBE_CONFIG}`,
      `--tsconfig=${TSCONFIG}`,
      `${FIXTURES}/unused-disable.ts`,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.output.toLowerCase()).toContain('unused oxlint-disable directive');
  });

  test('reports compiler adoption advice without blocking the lint gate', async () => {
    const result = await run([
      ...OXLINT,
      `--config=${PROBE_CONFIG}`,
      `--tsconfig=${TSCONFIG}`,
      '--format=json',
      `${FIXTURES}/compiler-advice.tsx`,
    ]);
    const report = JSON.parse(result.output) as {
      diagnostics: { code: string; severity: string }[];
    };
    for (const rule of ['react(refs)', 'react(set-state-in-effect)']) {
      expect(report.diagnostics.some((item) => item.code === rule)).toBe(true);
      expect(
        report.diagnostics
          .filter((item) => item.code === rule)
          .every((item) => item.severity === 'warning')
      ).toBe(true);
    }
    expect(result.exitCode).toBe(0);
  });

  test('continues to reject conditional React hooks', async () => {
    const result = await run([
      ...OXLINT,
      `--config=${PROBE_CONFIG}`,
      `--tsconfig=${TSCONFIG}`,
      `${FIXTURES}/invalid-hook.tsx`,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('rules-of-hooks');
  });

  test('retains noImplicitAnyLet coverage in the Oxlint policy', async () => {
    const invalid = await run([
      ...OXLINT,
      `--config=${PROBE_CONFIG}`,
      `--tsconfig=${TSCONFIG}`,
      `${FIXTURES}/implicit-any.ts`,
    ]);
    const valid = await run([
      ...OXLINT,
      `--config=${PROBE_CONFIG}`,
      `--tsconfig=${TSCONFIG}`,
      `${FIXTURES}/valid.ts`,
    ]);

    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.output).toContain('no-implicit-any-let');
    expect(invalid.output).toContain('"implicit" needs a type annotation or initializer');
    expect(valid.exitCode).toBe(0);
  });

  test('rejects untyped var, nested, ambient, multiple and classic-for declarations', async () => {
    const result = await run([
      ...OXLINT,
      `--config=${PROBE_CONFIG}`,
      `--tsconfig=${TSCONFIG}`,
      `${FIXTURES}/implicit-any-cases.ts`,
    ]);

    expect(result.exitCode).not.toBe(0);
    for (const name of ['functionScoped', 'nested', 'ambient', 'first', 'index']) {
      expect(result.output).toContain(`"${name}" needs a type annotation or initializer`);
    }
  });

  test('keeps the custom declaration rule inside the project ignore boundaries', async () => {
    const result = await run([
      ...OXLINT,
      '--no-error-on-unmatched-pattern',
      `${FIXTURES}/implicit-any.ts`,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('no-implicit-any-let');
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
