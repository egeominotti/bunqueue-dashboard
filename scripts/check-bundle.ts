#!/usr/bin/env bun
/**
 * Bundle-size budget. Sums the gzipped JavaScript in `dist/assets` and fails if
 * it exceeds the budget, so a careless dependency can't silently bloat the app.
 * Run after `bun run build` (CI runs it on every push/PR).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../agent/logger';

const BUDGET_KB = 230; // total gzipped JS across all chunks
const dir = join(import.meta.dir, '..', 'dist', 'assets');

let jsFiles: string[];
try {
  jsFiles = readdirSync(dir).filter((f) => f.endsWith('.js'));
} catch {
  logger.error({ dir }, 'dist/assets not found — run `bun run build` first');
  process.exit(1);
}

let totalBytes = 0;
const breakdown = jsFiles
  .map((f) => {
    const gz = Bun.gzipSync(readFileSync(join(dir, f))).byteLength;
    totalBytes += gz;
    return { file: f, gzipKb: Number((gz / 1024).toFixed(1)) };
  })
  .sort((a, b) => b.gzipKb - a.gzipKb);

const totalKb = Number((totalBytes / 1024).toFixed(1));
logger.info(
  { totalKb, budgetKb: BUDGET_KB, chunks: jsFiles.length, largest: breakdown.slice(0, 5) },
  'bundle size (gzipped JS)'
);

if (totalKb > BUDGET_KB) {
  logger.error(
    { totalKb, budgetKb: BUDGET_KB, overByKb: Number((totalKb - BUDGET_KB).toFixed(1)) },
    'bundle exceeds size budget'
  );
  process.exit(1);
}

logger.info({ headroomKb: Number((BUDGET_KB - totalKb).toFixed(1)) }, 'bundle within budget');
