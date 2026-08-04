import { DEMO_FLOW } from './flows';
import { F, type Json } from './shared';

const fixtureJobs = (key: string): Json[] => (F[key] as { jobs?: Json[] })?.jobs ?? [];
const fallbackJob = (F.oneJob as { job?: Json }).job;
export const DEMO_JOB_POOL: Json[] = [
  ...fixtureJobs('emailsWaiting'),
  ...fixtureJobs('emailsCompleted'),
  ...(fallbackJob ? [fallbackJob] : []),
];
const QUEUES = ['emails', 'image-processing', 'reports', 'notifications'];

export function retagDemoJob(job: Json, queue: string, index: number): Json {
  const current = {
    ...job,
    name: typeof job.name === 'string' ? job.name : `${queue}-job`,
    ...(job.state === 'completed' && !Object.hasOwn(job, 'returnvalue')
      ? { returnvalue: { ok: true } }
      : {}),
    ...(job.state === 'failed' && !Object.hasOwn(job, 'failedReason')
      ? { failedReason: 'Demo job exhausted its retries' }
      : {}),
  };
  return queue === 'emails'
    ? current
    : { ...current, id: `${queue}-${String(job.id).slice(-12)}-${index}`, queue };
}

export function demoJobForId(id: string): Json {
  if (DEMO_FLOW[id]) return DEMO_FLOW[id];
  const exact = DEMO_JOB_POOL.find((job) => job.id === id);
  if (exact) return retagDemoJob(exact, 'emails', 0);
  for (const queue of QUEUES) {
    const retagged = DEMO_JOB_POOL.map((job, index) => retagDemoJob(job, queue, index)).find(
      (job) => job.id === id
    );
    if (retagged) return retagged;
  }
  const fallback = fallbackJob ?? { queue: 'emails', state: 'failed' };
  const customPrefix = 'demo-custom:';
  return {
    ...fallback,
    id,
    customId: id.startsWith(customPrefix) ? id.slice(customPrefix.length) : null,
  };
}
