import type { Job, QueueDetailResponse } from '@/lib/types';

export const RECENT_STATES = [
  'active',
  'waiting',
  'prioritized',
  'waiting-children',
  'completed',
  'failed',
  'delayed',
  'paused',
];

export const EMPTY_QUEUE_DETAIL: {
  detail: QueueDetailResponse;
  jobs: Job[];
  recentJobsError: string | null;
} = {
  detail: {
    ok: false,
    name: '',
    counts: {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      prioritized: 0,
      'waiting-children': 0,
      paused: 0,
    },
    paused: false,
    priorityCounts: {},
    dlqPreview: [],
    timestamp: 0,
  },
  jobs: [],
  recentJobsError: null,
};
