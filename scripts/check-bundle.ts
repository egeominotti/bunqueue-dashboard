#!/usr/bin/env bun
/**
 * Bundle-size budget. Measures the gzipped JavaScript of the INITIAL load — the
 * entry chunk plus everything it statically imports — and fails if it exceeds
 * the budget. Lazily-imported code (the demo shim, the AI copilot, etc.) is
 * loaded on demand and must NOT count against the initial-load budget, so it is
 * excluded via Vite's build manifest (dist/.vite/manifest.json). A separate,
 * generous cap on the grand total still catches a runaway dependency.
 * Run after `bun run build` (CI runs it on every push/PR).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../agent/logger';

const INITIAL_BUDGET_KB = 230; // gzipped JS on first paint (entry + static imports)
const TOTAL_BUDGET_KB = 1200; // gzipped JS across ALL chunks incl. lazy ones (runaway guard)

const distDir = join(import.meta.dir, '..', 'dist');
const assetsDir = join(distDir, 'assets');
const manifestPath = join(distDir, '.vite', 'manifest.json');

const gzipKb = (file: string) => Bun.gzipSync(readFileSync(join(distDir, file))).byteLength / 1024;

type ManifestEntry = {
  file: string;
  isEntry?: boolean;
  imports?: string[]; // static imports (chunk keys) — lazy ones live in dynamicImports
};
type Manifest = Record<string, ManifestEntry>;

let manifest: Manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
} catch {
  logger.error({ manifestPath }, 'build manifest not found — run `bun run build` first');
  process.exit(1);
}

// Collect the entry chunk + everything reachable through STATIC imports only.
const entryKeys = Object.keys(manifest).filter((k) => manifest[k]?.isEntry);
if (entryKeys.length === 0) {
  logger.error({ manifestPath }, 'no entry found in build manifest');
  process.exit(1);
}
const initialChunks = new Set<string>();
const walk = (key: string) => {
  const node = manifest[key];
  if (!node || initialChunks.has(node.file)) return;
  initialChunks.add(node.file);
  for (const imp of node.imports ?? []) walk(imp);
};
for (const k of entryKeys) walk(k);

let initialKb = 0;
const initialBreakdown = [...initialChunks]
  .filter((f) => f.endsWith('.js'))
  .map((f) => {
    const kb = gzipKb(f);
    initialKb += kb;
    return { file: f.replace(/^assets\//, ''), gzipKb: Number(kb.toFixed(1)) };
  })
  .sort((a, b) => b.gzipKb - a.gzipKb);

// Grand total across every emitted JS chunk (initial + lazy) as a runaway guard.
let totalKb = 0;
try {
  for (const f of readdirSync(assetsDir).filter((f) => f.endsWith('.js'))) {
    totalKb += gzipKb(join('assets', f));
  }
} catch {
  totalKb = initialKb;
}

const initial = Number(initialKb.toFixed(1));
const total = Number(totalKb.toFixed(1));
logger.info(
  {
    initialKb: initial,
    initialBudgetKb: INITIAL_BUDGET_KB,
    totalKb: total,
    totalBudgetKb: TOTAL_BUDGET_KB,
    initialChunks: initialBreakdown.length,
    largestInitial: initialBreakdown.slice(0, 5),
  },
  'bundle size (gzipped JS)'
);

let failed = false;
if (initial > INITIAL_BUDGET_KB) {
  logger.error(
    { initialKb: initial, budgetKb: INITIAL_BUDGET_KB, overByKb: Number((initial - INITIAL_BUDGET_KB).toFixed(1)) },
    'initial-load bundle exceeds budget'
  );
  failed = true;
}
if (total > TOTAL_BUDGET_KB) {
  logger.error(
    { totalKb: total, budgetKb: TOTAL_BUDGET_KB, overByKb: Number((total - TOTAL_BUDGET_KB).toFixed(1)) },
    'total bundle exceeds runaway guard'
  );
  failed = true;
}
if (failed) process.exit(1);

logger.info(
  { initialHeadroomKb: Number((INITIAL_BUDGET_KB - initial).toFixed(1)) },
  'bundle within budget'
);
