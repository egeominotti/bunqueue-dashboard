import type { AddJobBody } from '@/lib/bq';
import type { CloneJobState } from '@/lib/cloneJob';
import { opaqueHttpIdError } from '@/lib/upstreamPaths';
import { parseJobData } from './data';
import {
  addJobCloneDefaults,
  MAX_DELAY_MS,
  numberString,
  parseAddJobNumbers,
  parseRepeat,
  queueNameError,
  resolveBackoff,
} from './options';

export interface AddJobFormValues {
  queue: string;
  name: string;
  dataText: string;
  count: string;
  priority: string;
  delay: string;
  runAt: string;
  maxAttempts: string;
  backoff: string;
  timeout: string;
  ttl: string;
  jobId: string;
  removeOnComplete: boolean;
  removeOnFail: boolean;
  durable: boolean;
  lifo: boolean;
  backoffType: '' | 'fixed' | 'exponential';
  tags: string;
  groupId: string;
  dependsOn: string;
  uniqueKey: string;
  repeatText: string;
}

export type SetAddJobValue = <K extends keyof AddJobFormValues>(
  key: K,
  value: AddJobFormValues[K]
) => void;

export function initialAddJobValues(clone?: CloneJobState['clone']): AddJobFormValues {
  const options = clone?.options ?? {};
  const defaults = addJobCloneDefaults(options);
  return {
    queue: clone?.queue ?? '',
    name: clone?.name ?? 'default',
    dataText: clone?.dataText ?? '{\n  "hello": "world"\n}',
    count: '1',
    priority: numberString(options.priority),
    delay: '',
    runAt: '',
    maxAttempts: numberString(options.maxAttempts),
    backoff: defaults.backoff,
    timeout: numberString(options.timeout),
    ttl: defaults.ttl,
    jobId: '',
    removeOnComplete: options.removeOnComplete ?? false,
    removeOnFail: options.removeOnFail ?? false,
    durable: false,
    lifo: false,
    backoffType: defaults.backoffType,
    tags: defaults.tags,
    groupId: defaults.groupId,
    dependsOn: '',
    uniqueKey: '',
    repeatText: '',
  };
}

type BuildResult =
  | { ok: true; target: string; body: AddJobBody; count: number }
  | { ok: false; msg: string; field: 'data' | 'result' };

export function buildAddJobSubmission(values: AddJobFormValues, now = Date.now()): BuildResult {
  const target = values.queue.trim();
  const invalidQueue = queueNameError(target);
  if (invalidQueue) return failure(invalidQueue);

  const jobName = values.name.trim();
  if (!jobName || jobName.length > 256) {
    return failure('Job name must be a non-empty string of at most 256 characters');
  }
  const parsedData = parseJobData(values.dataText);
  if (!parsedData.ok) {
    return {
      ok: false,
      msg: parsedData.msg,
      field: parsedData.kind === 'json' ? 'data' : 'result',
    };
  }

  const numeric = parseAddJobNumbers({
    priority: values.priority,
    delay: values.runAt.trim() ? '' : values.delay,
    maxAttempts: values.maxAttempts,
    backoff: values.backoff,
    timeout: values.timeout,
    ttl: values.ttl,
  });
  if (!numeric.ok) return failure(numeric.msg);

  let effectiveDelay = numeric.options.delay;
  if (values.runAt.trim()) {
    const targetMs = new Date(values.runAt).getTime();
    if (!Number.isFinite(targetMs)) return failure('Run at is not a valid date/time');
    effectiveDelay = Math.max(0, targetMs - now);
    if (effectiveDelay > MAX_DELAY_MS) {
      return failure('Run at must be within the next 365 days');
    }
  }
  const backoff = resolveBackoff(numeric.options.backoff, values.backoffType);
  if (!backoff.ok) return failure(backoff.msg);

  const tags = commaList(values.tags);
  const dependencies = commaList(values.dependsOn);
  const requestedJobId = values.jobId.trim();
  if (requestedJobId) {
    const idError = opaqueHttpIdError(requestedJobId);
    if (idError) return failure(`Job ID: ${idError}`);
  }
  for (const dependency of dependencies) {
    const idError = opaqueHttpIdError(dependency);
    if (idError) return failure(`Dependency ID "${dependency}": ${idError}`);
  }
  const repeat = parseRepeat(values.repeatText);
  if (!repeat.ok) return failure(repeat.msg);

  const count = Number(values.count);
  if (!Number.isSafeInteger(count) || count < 1 || count > 10000) {
    return failure('Count must be a whole number from 1 to 10000');
  }
  return {
    ok: true,
    target,
    count,
    body: {
      name: jobName,
      data: parsedData.data,
      priority: numeric.options.priority,
      delay: effectiveDelay,
      maxAttempts: numeric.options.maxAttempts,
      backoff: backoff.backoff,
      timeout: numeric.options.timeout,
      ttl: numeric.options.ttl,
      jobId: requestedJobId || undefined,
      removeOnComplete: values.removeOnComplete || undefined,
      removeOnFail: values.removeOnFail || undefined,
      durable: values.durable || undefined,
      lifo: values.lifo || undefined,
      tags: tags.length ? tags : undefined,
      groupId: values.groupId.trim() || undefined,
      dependsOn: dependencies.length ? dependencies : undefined,
      uniqueKey: values.uniqueKey.trim() || undefined,
      repeat: repeat.repeat,
    },
  };
}

const failure = (msg: string): BuildResult => ({ ok: false, msg, field: 'result' });
const commaList = (text: string): string[] =>
  text
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
