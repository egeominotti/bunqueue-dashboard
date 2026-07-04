#!/usr/bin/env bun
/**
 * Aggregate coverage floor. Bun's own `coverageThreshold` (bunfig.toml) is
 * applied PER FILE, so a single legitimately low-coverage module (the lazily
 * loaded copilot tools, UI hooks) would fail every run no matter how good the
 * overall suite is. This script instead sums the lcov report produced by
 * `bun test --coverage --coverage-reporter=lcov` and enforces a floor on the
 * TOTALS, which is the number that should never erode.
 *
 * Run via `bun run test:coverage` (CI runs it on every push/PR).
 * Raise the floors as coverage grows; never lower them to make a change pass.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../agent/logger';

// Floors sit ~2pts under the measured lcov totals at v0.0.22 (72.7% lines,
// 60.3% functions after the hook tests — note lcov weights by line count, so
// it reads lower than `bun test --coverage`'s per-file table average).
const LINES_FLOOR = 0.7;
const FUNCTIONS_FLOOR = 0.58;

const lcovPath = join(import.meta.dir, '..', 'coverage', 'lcov.info');

let lcov: string;
try {
  lcov = readFileSync(lcovPath, 'utf8');
} catch {
  logger.error(
    { lcovPath },
    'lcov report not found — run `bun test --coverage --coverage-reporter=lcov` first'
  );
  process.exit(1);
}

// Sum the per-file records: LF/LH = lines found/hit, FNF/FNH = functions found/hit.
let linesFound = 0;
let linesHit = 0;
let fnFound = 0;
let fnHit = 0;
for (const line of lcov.split('\n')) {
  if (line.startsWith('LF:')) linesFound += Number(line.slice(3));
  else if (line.startsWith('LH:')) linesHit += Number(line.slice(3));
  else if (line.startsWith('FNF:')) fnFound += Number(line.slice(4));
  else if (line.startsWith('FNH:')) fnHit += Number(line.slice(4));
}

if (linesFound === 0 || fnFound === 0) {
  logger.error({ lcovPath, linesFound, fnFound }, 'lcov report is empty — refusing to pass');
  process.exit(1);
}

const lines = linesHit / linesFound;
const functions = fnHit / fnFound;
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

logger.info(
  {
    lines: pct(lines),
    linesFloor: pct(LINES_FLOOR),
    functions: pct(functions),
    functionsFloor: pct(FUNCTIONS_FLOOR),
  },
  'aggregate test coverage'
);

let failed = false;
if (lines < LINES_FLOOR) {
  logger.error({ lines: pct(lines), floor: pct(LINES_FLOOR) }, 'line coverage below floor');
  failed = true;
}
if (functions < FUNCTIONS_FLOOR) {
  logger.error(
    { functions: pct(functions), floor: pct(FUNCTIONS_FLOOR) },
    'function coverage below floor'
  );
  failed = true;
}
if (failed) process.exit(1);

logger.info('coverage above floor');
