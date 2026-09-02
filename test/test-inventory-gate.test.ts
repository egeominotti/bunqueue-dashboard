import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

const projectRoot = resolve(import.meta.dir, '..');
const inventoryScript = resolve(projectRoot, 'scripts/check-test-inventory.ts');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.isFile() || (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx'))) return [];
    return [relative(projectRoot, path).split(sep).join('/')];
  });
}

function lcovFor(files: string[]): string {
  return files.map((file) => `SF:${file}\nend_of_record\n`).join('');
}

async function runInventory(lcov: string): Promise<{ code: number; output: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'test-inventory-'));
  const lcovPath = join(directory, 'lcov.info');
  writeFileSync(lcovPath, lcov);
  const process = Bun.spawn(['bun', inventoryScript], {
    cwd: projectRoot,
    env: { ...Bun.env, LCOV_PATH: lcovPath },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { code, output: `${stdout}${stderr}` };
}

const applicationFiles = [
  ...sourceFiles(resolve(projectRoot, 'agent')),
  ...sourceFiles(resolve(projectRoot, 'src')),
];

describe('application test inventory gate', () => {
  test('accepts explicitly external and type-only modules outside unit coverage', async () => {
    const covered = applicationFiles.filter(
      (file) => file !== 'src/main.tsx' && file !== 'src/lib/types.ts'
    );
    const result = await runInventory(lcovFor(covered));
    expect(result.code).toBe(0);
    expect(result.output).toContain('every application module has an explicit test strategy');
  });

  test('fails and names a runtime module missing from the report', async () => {
    const covered = applicationFiles.filter((file) => file !== 'src/App.tsx');
    const result = await runInventory(lcovFor(covered));
    expect(result.code).toBe(1);
    expect(result.output).toContain('source coverage inventory is incomplete');
    expect(result.output).toContain('src/App.tsx');
  });
});
