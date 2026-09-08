#!/usr/bin/env bun
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { logger } from '../agent/logger';

const projectRoot = resolve(import.meta.dir, '..');
const lcovPath = process.env.LCOV_PATH || resolve(projectRoot, 'coverage/lcov.info');

const externalEntrypoints = new Map([
  ['agent/backup/standaloneWorker.ts', 'spawned by the backup process executor'],
  ['agent/dbReadWorker.ts', 'SQLite thread inside the supervised disposable process'],
  ['agent/db/readProcessMain.ts', 'executed by real SQLite process, source and native-binary smoke tests'],
  ['agent/dbQueryWorker.ts', 'spawned by the database worker factory'],
  ['agent/index.ts', 'started by agent and package runtime tests'],
  ['src/main.tsx', 'started by the Playwright production-browser suite'],
]);

const typeOnlyModules = new Set([
  'agent/backup/workerProtocol.ts',
  'agent/flow/types.ts',
  'agent/manager/types.ts',
  'agent/server/types.ts',
  'src/features/backups/application/BackupRepository.ts',
  'src/features/flows/application/FlowOperationsRepository.ts',
  'src/features/queue-operations/application/QueueOperationsRepository.ts',
  'src/features/workflows/application/WorkflowControlRepository.ts',
  'src/lib/bqTypes.ts',
  'src/lib/controlTypes.ts',
  'src/lib/types.ts',
  'src/pages/control/bulkAdd/formTypes.ts',
  'src/pages/control/database/types.ts',
  'src/pages/control/jobInspector/types.ts',
  'src/vite-env.d.ts',
]);

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(path);
    if (!entry.isFile() || (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx'))) return [];
    return [relative(projectRoot, path).split(sep).join('/')];
  });
}

function normalizeSourcePath(path: string): string {
  const normalized = path.trim().split(sep).join('/');
  const root = `${projectRoot.split(sep).join('/')}/`;
  return normalized.startsWith(root) ? normalized.slice(root.length) : normalized.replace(/^\.\//, '');
}

let lcov: string;
try {
  lcov = readFileSync(lcovPath, 'utf8');
} catch {
  logger.error({ lcovPath }, 'lcov report not found — run `bun run test:coverage` first');
  process.exit(1);
}

const sourceFiles = [...collectTypeScriptFiles(resolve(projectRoot, 'agent')), ...collectTypeScriptFiles(resolve(projectRoot, 'src'))].sort();
const sourceSet = new Set(sourceFiles);
const coveredFiles = new Set(
  [...lcov.matchAll(/^SF:(.+)$/gm)].map((match) => normalizeSourcePath(match[1] ?? ''))
);
const exemptions = new Set([...externalEntrypoints.keys(), ...typeOnlyModules]);

const staleExemptions = [...exemptions].filter((path) => !sourceSet.has(path));
const untrackedRuntimeFiles = sourceFiles.filter(
  (path) => !coveredFiles.has(path) && !exemptions.has(path)
);

if (staleExemptions.length > 0 || untrackedRuntimeFiles.length > 0) {
  logger.error(
    { staleExemptions, untrackedRuntimeFiles },
    'source coverage inventory is incomplete'
  );
  process.exit(1);
}

logger.info(
  {
    sourceFiles: sourceFiles.length,
    coveredByUnitTests: sourceFiles.filter((path) => coveredFiles.has(path)).length,
    externalEntrypoints: externalEntrypoints.size,
    typeOnlyModules: typeOnlyModules.size,
  },
  'every application module has an explicit test strategy'
);
