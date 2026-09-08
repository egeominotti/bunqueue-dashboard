/** Critical safety paths have individual floors; unrelated UI coverage cannot hide regressions. */
export const CRITICAL_COVERAGE = {
  'agent/manager/process.ts': [0.95, 0.94],
  'agent/manager/configStore.ts': [0.90, 0.90],
  'agent/server/policy.ts': [0.99, 0.95],
  'agent/server/lifecycle.ts': [0.98, 0.90],
  'agent/server/managedRuntime.ts': [0.95, 0.95],
  'agent/db/processWorker.ts': [0.85, 0.85],
  'agent/db/queryTimeout.ts': [0.85, 0.85],
  'agent/db/exportTimeout.ts': [0.75, 0.80],
} as const;

export function criticalCoverageFailures(lcov: string): string[] {
  const failures: string[] = [];
  const records = lcov.split('end_of_record').map((record) =>
    Object.fromEntries(record.trim().split('\n').filter((line) => line.includes(':')).map((line) => {
      const separator = line.indexOf(':');
      return [line.slice(0, separator), line.slice(separator + 1).trim()];
    }))
  );
  for (const [path, [linesFloor, functionsFloor]] of Object.entries(CRITICAL_COVERAGE)) {
    const matches = records.filter((record) => {
      const source = record.SF?.replaceAll('\\', '/');
      return source === path || source?.endsWith(`/${path}`);
    });
    if (matches.length !== 1) { failures.push(`${path}: expected exactly one coverage record`); continue; }
    const record = matches[0]!;
    const [lines, linesHit, functions, functionsHit] = ['LF', 'LH', 'FNF', 'FNH'].map((key) => Number(record[key]));
    if (![lines, linesHit, functions, functionsHit].every((count) => Number.isSafeInteger(count) && count! >= 0)
      || !lines || !functions || linesHit! > lines || functionsHit! > functions) {
      failures.push(`${path}: malformed coverage counts`);
      continue;
    }
    if (linesHit! / lines < linesFloor || functionsHit! / functions < functionsFloor) {
      failures.push(`${path}: ${(linesHit! / lines * 100).toFixed(2)}% lines / ${(functionsHit! / functions * 100).toFixed(2)}% functions; requires ${linesFloor * 100}% / ${functionsFloor * 100}%`);
    }
  }
  return failures;
}
