export const QUEUE_DETAIL_COUNT_KEYS = [
  'waiting',
  'prioritized',
  'active',
  'waiting-children',
  'delayed',
  'completed',
  'failed',
  'paused',
] as const;

export const QUEUE_DETAIL_RECENT_STATES = [
  'active',
  'waiting',
  'prioritized',
  'waiting-children',
  'completed',
  'failed',
  'delayed',
];

export const MAX_DEPTH_POINTS = 40;
export const DEPTH_SAMPLE_MS = 2000;
