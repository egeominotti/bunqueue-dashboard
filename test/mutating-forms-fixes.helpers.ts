import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';

import { act } from 'react';

import {
  acceptedBulkIds,
  acceptedJobId,
  createdSummary,
  parseAddJobNumbers,
  parseRepeat,
  queueNameError,
  resolveBackoff,
} from '../src/pages/control/AddJob';

import {
  asNum,
  asStr,
  bulkSummary,
  coerceBody,
  parseBulkDefaults,
  parseDedup,
  parseInput,
  specWouldDropValues,
  validateBulkItems,
} from '../src/pages/control/BulkAddJobs';

import {
  assertCronCreateResponse,
  assertCronDeleteResponse,
  buildCronBody,
  type CronFormValues,
  useClampedPage as useClampedPageCron,
  useTransientFlag,
} from '../src/pages/control/CronManager';

import {
  buildWebhookBody,
  displayWebhookUrl,
  useClampedPage as useClampedPageHooks,
} from '../src/pages/control/Webhooks';

import { renderHook, settle } from './domSetup';

const cronValues = (overrides: Partial<CronFormValues> = {}): CronFormValues => ({
  name: ' daily-report ',
  queue: ' reports ',
  mode: 'cron',
  schedule: '0 9 * * *',
  every: '',
  dataText: '{"report":true}',
  timezone: 'Europe/Rome',
  priority: '-2',
  preventOverlap: true,
  skipIfNoWorker: false,
  maxLimit: '25',
  immediately: false,
  skipMissedOnRestart: true,
  uniqueKey: ' daily-report-key ',
  dedupTtl: '60000',
  dedupExtend: false,
  dedupReplace: true,
  jobMaxAttempts: '3',
  jobBackoff: '1000',
  jobTimeout: '30000',
  jobDelay: '0',
  jobStallTimeout: '5000',
  jobRemoveOnComplete: true,
  jobRemoveOnFail: false,
  ...overrides,
});

export type { CronFormValues };
export {
  acceptedBulkIds,
  acceptedJobId,
  act,
  asNum,
  asStr,
  assertCronCreateResponse,
  assertCronDeleteResponse,
  buildCronBody,
  buildWebhookBody,
  bulkSummary,
  coerceBody,
  createdSummary,
  cronValues,
  describe,
  displayWebhookUrl,
  expect,
  parseAddJobNumbers,
  parseBulkDefaults,
  parseDedup,
  parseInput,
  parseRepeat,
  queueNameError,
  readFileSync,
  renderHook,
  resolveBackoff,
  settle,
  specWouldDropValues,
  test,
  useClampedPageCron,
  useClampedPageHooks,
  useTransientFlag,
  validateBulkItems,
};
