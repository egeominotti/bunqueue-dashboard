import { describe, expect, readFileSync, test } from './mutating-forms-fixes.helpers';

// These forms cannot be driven through the happy-dom harness (React's onChange
// never fires there), so guard the call sites at the source level: the value
// that passes validation must be the value handed to the API.
describe('submit the validated value', () => {
  const read = (p: string) =>
    readFileSync(new URL(`../src/pages/control/${p}`, import.meta.url), 'utf8');

  test('AddJob enqueues against the trimmed queue', () => {
    const src = read('AddJob.tsx');
    expect(src).toContain('bq.addJob(target,');
    expect(src).not.toContain('bq.addJob(queue,');
    expect(src).not.toContain('bq.addJobsBulk(\n          queue,');
  });

  test('BulkAddJobs imports against the trimmed queue', () => {
    const src = read('BulkAddJobs.tsx');
    expect(src).toContain('bq.addJobsBulk(target,');
    expect(src).not.toContain('bq.addJobsBulk(queue,');
  });

  test('CronManager persists the trimmed name and queue', () => {
    const form = read('cron/CronForm.tsx');
    const model = read('cron/model.ts');
    expect(model).toContain('const name = values.name.trim();');
    expect(model).toContain('const queue = values.queue.trim();');
    expect(model).toContain('const body: CreateCronBody = {');
    expect(form).toContain('const built = buildCronBody(values);');
    expect(form).toContain('await onCreate(built.body, lease.isCurrent)');
    expect(form).not.toContain('onCreate(values');
    expect(model).not.toContain('name: values.name');
    expect(model).not.toContain('queue: values.queue');
  });
});
