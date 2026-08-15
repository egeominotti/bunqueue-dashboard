import { readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.claude',
  '.codex',
  'agent',
  'coverage',
  'dist',
  'docs/.vitepress',
  'node_modules',
  'scripts',
  'test/fixtures/oxlint-policy',
]);

interface Violation {
  column: number;
  file: string;
  line: number;
  name: string;
}

export function findImplicitAnyLets(file: string, source: string): Violation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (isImplicitAnyVariable(node)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile));
      violations.push({
        column: position.character + 1,
        file,
        line: position.line + 1,
        name: node.name.text,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      const projectPath = relative(PROJECT_ROOT, path);
      if (entry.isDirectory()) {
        return isIgnoredDirectory(projectPath) ? [] : sourceFiles(path);
      }
      return TYPESCRIPT_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
    })
  );
  return nested.flat();
}

function isImplicitAnyVariable(node: ts.Node): node is ts.VariableDeclaration & {
  name: ts.Identifier;
} {
  if (
    !ts.isVariableDeclaration(node) ||
    !ts.isIdentifier(node.name) ||
    node.type ||
    node.initializer ||
    !ts.isVariableDeclarationList(node.parent)
  ) {
    return false;
  }
  if (node.parent.flags & ts.NodeFlags.Const) return false;
  const statement = node.parent.parent;
  return !ts.isForInStatement(statement) && !ts.isForOfStatement(statement);
}

export function isIgnoredDirectory(projectPath: string): boolean {
  const normalizedPath = projectPath.replaceAll('\\', '/');
  for (const ignored of IGNORED_DIRECTORIES) {
    if (normalizedPath === ignored || normalizedPath.startsWith(`${ignored}/`)) return true;
  }
  return false;
}

function scriptKind(file: string): ts.ScriptKind {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

async function main(): Promise<void> {
  const explicit = process.argv.slice(2).map((file) => resolve(PROJECT_ROOT, file));
  const files = explicit.length ? explicit : await sourceFiles(PROJECT_ROOT);
  const violations = (
    await Promise.all(
      files.sort().map(async (file) => findImplicitAnyLets(file, await Bun.file(file).text()))
    )
  ).flat();

  if (violations.length) {
    console.error('Implicit any variable declarations are forbidden:');
    for (const violation of violations) {
      console.error(
        `${relative(PROJECT_ROOT, violation.file)}:${violation.line}:${violation.column} ` +
          `"${violation.name}" needs a type annotation or initializer`
      );
    }
    process.exit(1);
  }

  console.log(`${files.length} TypeScript files have no implicit-any variable declarations.`);
}

if (import.meta.main) await main();
