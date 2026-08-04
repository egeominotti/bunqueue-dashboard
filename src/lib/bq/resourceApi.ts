import { getBaseUrl } from '@/components/dashboard/stores/connectionStore';
import type { CronFull } from '../bqTypes';
import { parseWebhooksPayload, parseWorkersPayload } from '../dashboardPayloads';
import {
  decodedHttpPathSegment,
  eventQueuePathSegment,
  opaqueHttpPathSegment,
} from '../upstreamPaths';
import { body, srv } from './transport';
import type { AddWebhookBody, CreateCronBody } from './types';

export const resourceApi = {
  crons: () => srv<{ ok: boolean; crons: CronFull[] }>('/crons'),
  createCron: (cron: CreateCronBody) => srv('/crons', body('POST', cron)),
  deleteCron: (name: string) =>
    srv(`/crons/${decodedHttpPathSegment(name, 'Cron name', 256)}`, { method: 'DELETE' }),
  webhooks: async () => parseWebhooksPayload(await srv<unknown>('/webhooks')),
  addWebhook: (webhook: AddWebhookBody) => srv('/webhooks', body('POST', webhook)),
  removeWebhook: (id: string) =>
    srv(`/webhooks/${opaqueHttpPathSegment(id)}`, { method: 'DELETE' }),
  setWebhookEnabled: (id: string, enabled: boolean) =>
    srv(`/webhooks/${opaqueHttpPathSegment(id)}/enabled`, body('PUT', { enabled })),
  workers: async () => parseWorkersPayload(await srv<unknown>('/workers')),
  unregisterWorker: (id: string) =>
    srv(`/workers/${opaqueHttpPathSegment(id)}`, { method: 'DELETE' }),
  eventsUrl: (queue?: string) =>
    getBaseUrl() + (queue ? `/events/queues/${eventQueuePathSegment(queue)}` : '/events'),
};
