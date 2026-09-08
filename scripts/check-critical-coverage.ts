import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CRITICAL_COVERAGE, criticalCoverageFailures } from './criticalCoveragePolicy';

const failures = criticalCoverageFailures(readFileSync(process.env.LCOV_PATH || resolve(import.meta.dir, '../coverage/lcov.info'), 'utf8'));
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Critical coverage floors passed for ${Object.keys(CRITICAL_COVERAGE).length} modules.`);
