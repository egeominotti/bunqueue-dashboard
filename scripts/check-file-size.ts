import { readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const MAX_LINES = 300;
const PROJECT_ROOT = resolve(import.meta.dir, '..');
const EXTENSIONS = new Set(['.ts', '.tsx']);
const GENERATED_DIRECTORIES = new Set([
  '.git',
  '.claude/worktrees',
  'coverage',
  'dist',
  'docs/.vitepress/cache',
  'docs/.vitepress/dist',
]);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      const projectPath = relative(PROJECT_ROOT, path);
      if (entry.isDirectory()) {
        return entry.name === 'node_modules' || GENERATED_DIRECTORIES.has(projectPath)
          ? []
          : sourceFiles(path);
      }
      return EXTENSIONS.has(extname(entry.name)) ? [path] : [];
    })
  );
  return nested.flat();
}

const files = (await sourceFiles(PROJECT_ROOT)).sort();
const violations: Array<{ file: string; lines: number }> = [];
for (const file of files) {
  const source = await Bun.file(file).text();
  const lines = source.length === 0 ? 0 : source.split(/\r?\n/).length;
  if (lines > MAX_LINES) violations.push({ file: relative(PROJECT_ROOT, file), lines });
}

if (violations.length) {
  console.error(`Source files must contain at most ${MAX_LINES} lines:`);
  for (const violation of violations.sort((a, b) => b.lines - a.lines)) {
    console.error(`- ${violation.file}: ${violation.lines}`);
  }
  process.exit(1);
}

console.log(`${files.length} project TypeScript files satisfy the ${MAX_LINES}-line limit.`);
