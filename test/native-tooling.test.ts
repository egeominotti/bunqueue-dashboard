import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import manifest from '../package.json';

const projectFiles = ['src/main.ts', 'agent/main.ts', 'examples/main.ts', 'e2e/main.ts'];
const projects = [
  'tsconfig.json',
  'tsconfig.agent.json',
  'tsconfig.examples.json',
  'tsconfig.e2e.json',
];

test('typecheck scripts work without tsc and reject errors in every project despite a check alias', async () => {
  const directory = await fixture();
  try {
    for (let index = 0; index < projects.length; index++) {
      await mkdir(join(directory, dirname(projectFiles[index])), { recursive: true });
      await Bun.write(
        join(directory, projects[index]),
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, types: [] },
          files: [projectFiles[index]],
        })
      );
      await Bun.write(join(directory, projectFiles[index]), 'export const value: number = 1;\n');
    }
    const valid = await run(directory, 'typecheck');
    expect(valid.output).not.toContain('command not found');
    expect(valid.exitCode).toBe(0);
    for (const file of projectFiles) {
      await Bun.write(join(directory, file), 'export const value: number = "wrong";\n');
      const invalid = await run(directory, 'typecheck');
      expect(invalid.exitCode).not.toBe(0);
      expect(invalid.output).toContain('TS2322');
      expect(invalid.output).toContain(file);
      await Bun.write(join(directory, file), 'export const value: number = 1;\n');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test('format scripts use Bun without oxfmt and preserve formatting policy and ignored paths', async () => {
  const directory = await fixture();
  try {
    await Bun.write(
      join(directory, '.oxfmtrc.json'),
      await Bun.file(new URL('../.oxfmtrc.json', import.meta.url)).text()
    );
    await mkdir(join(directory, 'src'));
    await mkdir(join(directory, 'scripts'));
    await Bun.write(join(directory, 'src/main.ts'), 'export const text="value"');
    const ignored = 'export const ignored="unchanged"';
    await Bun.write(join(directory, 'scripts/ignored.ts'), ignored);
    const invalid = await run(directory, 'format:check');
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.output).toContain('src/main.ts');
    expect((await run(directory, 'format')).exitCode).toBe(0);
    expect(await Bun.file(join(directory, 'src/main.ts')).text()).toBe(
      "export const text = 'value';\n"
    );
    expect(await Bun.file(join(directory, 'scripts/ignored.ts')).text()).toBe(ignored);
    expect((await run(directory, 'format:check')).exitCode).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-native-tooling-'));
  const scripts = Object.fromEntries(
    Object.entries(manifest.scripts).filter(
      ([name]) => name.startsWith('typecheck') || name === 'format' || name === 'format:check'
    )
  );
  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify({
      type: 'module',
      scripts: { ...scripts, check: 'exit 97' },
    })
  );
  return directory;
}

async function run(directory: string, script: string) {
  const child = Bun.spawn([process.execPath, 'run', script], {
    cwd: directory,
    env: { ...process.env, PATH: dirname(process.execPath), NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, output: `${stdout}\n${stderr}` };
  } finally {
    clearTimeout(timeout);
  }
}
