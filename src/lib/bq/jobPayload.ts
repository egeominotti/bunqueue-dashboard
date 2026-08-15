import { opaqueHttpIdError } from '../upstreamPaths';
import type { AddJobBody, BulkJobBody, RepeatOptions } from './types';

const MAX_REPEAT_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_BULK_JOB_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_BULK_JOB_COUNT = 10_000;
const UNSAFE_FIELDS = [
  'childrenIds',
  'parentId',
  'failParentOnFailure',
  'removeDependencyOnFailure',
  'continueParentOnFailure',
  'ignoreDependencyOnFailure',
  'keepLogs',
  'sizeLimit',
  'debounceId',
  'debounceTtl',
] as const;

function assertSafeRepeat(repeat: RepeatOptions | undefined): void {
  if (repeat === undefined) return;
  if (repeat === null || typeof repeat !== 'object' || Array.isArray(repeat)) {
    throw new TypeError('Repeat must be an object with a positive "every" interval');
  }
  const unsupported = Object.keys(repeat).filter((key) => key !== 'every' && key !== 'limit');
  if (unsupported.length) {
    throw new TypeError(
      `Unsupported repeat option(s): ${unsupported.join(', ')}. bunqueue v2.8.59 pattern repeats are unsafe; use the Cron API instead.`
    );
  }
  if (!Number.isSafeInteger(repeat.every) || repeat.every < 1 || repeat.every > MAX_REPEAT_MS) {
    throw new TypeError(`Repeat "every" must be a whole number from 1 to ${MAX_REPEAT_MS} ms`);
  }
  if (repeat.limit !== undefined && (!Number.isSafeInteger(repeat.limit) || repeat.limit < 1)) {
    throw new TypeError('Repeat "limit" must be a whole number of at least 1');
  }
}

function assertValidJobName(value: unknown): void {
  if (value !== undefined && (typeof value !== 'string' || !value || value.length > 256)) {
    throw new TypeError('Job name must be a non-empty string of at most 256 characters');
  }
}

function assertNoUnsafeFields(job: BulkJobBody): void {
  const raw = job as unknown as Record<string, unknown>;
  const unsafe = UNSAFE_FIELDS.filter((field) => raw[field] !== undefined);
  if (unsafe.length) {
    throw new TypeError(
      `Unsupported Bunqueue v2.8.59 enqueue option(s): ${unsafe.join(', ')}. Flow topology must use the atomic flow API; inert compatibility fields are not sent.`
    );
  }
}

function manageableId(field: string, id: string): void {
  const error = opaqueHttpIdError(id);
  if (error) {
    throw new TypeError(
      `${field}: ${error}. The job would not be manageable through v2.8.59 HTTP.`
    );
  }
}

function validateAddJob(raw: Record<string, unknown>): void {
  assertValidJobName(raw.name);
  assertSafeRepeat(raw.repeat as RepeatOptions | undefined);
  assertNoUnsafeFields(raw as unknown as BulkJobBody);
  if (
    raw.dependsOn !== undefined &&
    (!Array.isArray(raw.dependsOn) || !raw.dependsOn.every((id) => typeof id === 'string'))
  ) {
    throw new TypeError('dependsOn must be an array of job ID strings');
  }
  if (raw.jobId !== undefined) manageableId('jobId', raw.jobId as string);
  for (const id of (raw.dependsOn ?? []) as string[]) manageableId('dependsOn', id);
}

export function encodedAddJobRequest(job: AddJobBody): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(job);
  } catch {
    throw new TypeError('Job payload must be JSON serializable');
  }
  if (encoded === undefined) throw new TypeError('Job payload must be JSON serializable');
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    throw new TypeError('Job payload encoding failed');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Job payload must serialize to a JSON object');
  }
  validateAddJob(value as Record<string, unknown>);
  return encoded;
}

function translatedBulkJob({ jobId, ...job }: BulkJobBody) {
  return jobId === undefined ? job : { ...job, customId: jobId };
}

function validateEncodedBulkJob(encoded: string): void {
  const value = JSON.parse(encoded) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('must serialize to a JSON object');
  }
  const raw = value as Record<string, unknown>;
  if (raw.jobId !== undefined) {
    throw new TypeError('serialized jobId is invalid; the bulk transport requires customId');
  }
  assertValidJobName(raw.name);
  assertSafeRepeat(raw.repeat as RepeatOptions | undefined);
  assertNoUnsafeFields(raw as unknown as BulkJobBody);
  if (raw.customId !== undefined) {
    if (typeof raw.customId !== 'string') throw new TypeError('customId must be a string');
    manageableId('customId', raw.customId);
  }
  if (raw.dependsOn !== undefined) {
    if (!Array.isArray(raw.dependsOn) || !raw.dependsOn.every((id) => typeof id === 'string')) {
      throw new TypeError('dependsOn must be an array of job ID strings');
    }
    for (const dependency of raw.dependsOn as string[]) manageableId('dependsOn', dependency);
  }
}

function boundedUtf8Bytes(text: string, stopAfter: number): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}

type PayloadResult = { ok: true; bytes: number; body?: string } | { ok: false; error: string };
function serializePayload(
  jobs: readonly BulkJobBody[],
  maxBytes: number,
  buildBody: boolean
): PayloadResult {
  if (!Array.isArray(jobs) || jobs.length > MAX_BULK_JOB_COUNT) {
    return { ok: false, error: `Bulk request must contain at most ${MAX_BULK_JOB_COUNT} jobs` };
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return { ok: false, error: 'Bulk request payload limit is invalid' };
  }
  let bytes = 11;
  const parts = buildBody ? new Array<string>(jobs.length) : null;
  for (let index = 0; index < jobs.length; index++) {
    if (index) bytes += 1;
    if (bytes > maxBytes)
      return { ok: false, error: 'Bulk request payload exceeds the 64 MiB UTF-8 safety limit' };
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(translatedBulkJob(jobs[index]));
    } catch {
      return { ok: false, error: 'Bulk request payload must be JSON serializable' };
    }
    if (encoded === undefined)
      return { ok: false, error: 'Bulk request payload must be JSON serializable' };
    bytes += boundedUtf8Bytes(encoded, maxBytes - bytes);
    if (bytes > maxBytes)
      return { ok: false, error: 'Bulk request payload exceeds the 64 MiB UTF-8 safety limit' };
    if (buildBody) {
      try {
        validateEncodedBulkJob(encoded);
      } catch (error) {
        return {
          ok: false,
          error: `Bulk job ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    if (parts) parts[index] = encoded;
  }
  return { ok: true, bytes, body: parts ? `{"jobs":[${parts.join(',')}]}` : undefined };
}

export function bulkJobPayloadBudgetError(
  jobs: readonly BulkJobBody[],
  maxBytes = MAX_BULK_JOB_PAYLOAD_BYTES
): string | null {
  const result = serializePayload(jobs, maxBytes, false);
  return result.ok ? null : result.error;
}

export function encodedBulkJobRequest(jobs: readonly BulkJobBody[]): string {
  const result = serializePayload(jobs, MAX_BULK_JOB_PAYLOAD_BYTES, true);
  if (!result.ok) throw new TypeError(result.error);
  if (result.body === undefined) throw new TypeError('Bulk request payload encoding failed');
  return result.body;
}

export function assertBulkJobCount(jobs: readonly BulkJobBody[]): void {
  if (!Array.isArray(jobs) || jobs.length > MAX_BULK_JOB_COUNT) {
    throw new TypeError(`Bulk request must contain at most ${MAX_BULK_JOB_COUNT} jobs`);
  }
}
