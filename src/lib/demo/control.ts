import type { Json } from './shared';

export const DEMO_CONFIG = {
  command: 'bunx bunqueue@2.8.59 start',
  httpPort: 6790,
  tcpPort: 6791,
  dataPath: './data/bunqueue.db',
  extraEnv: { LOG_LEVEL: 'info' },
};

export const demoStatus = (): Json => ({
  status: 'running',
  generation: 1,
  configRevision: 1,
  pid: 42317,
  startedAt: Date.now() - 3_600_000,
  exitCode: null,
  healthy: true,
  version: '2.8.59',
  config: DEMO_CONFIG,
  runningConfig: DEMO_CONFIG,
  db: {
    path: DEMO_CONFIG.dataPath,
    exists: true,
    size: 2_621_440,
    walSize: 49_152,
    shmSize: 32_768,
    totalSize: 2_703_360,
    mtimeMs: Date.now() - 12_000,
  },
});

export const demoWorkers = (): Json => {
  const now = Date.now();
  return {
    ok: true,
    data: {
      workers: [
        {
          id: 'wrk-9f21c3d0',
          name: 'worker-emails-1',
          queues: ['emails', 'notifications'],
          concurrency: 10,
          hostname: 'worker-01',
          pid: 3411,
          status: 'active',
          registeredAt: now - 5_400_000,
          lastSeen: now - 4_000,
          activeJobs: 0,
          processedJobs: 1284,
          failedJobs: 6,
          currentJob: null,
          uptime: 5_400_000,
        },
        {
          id: 'wrk-4b77aa19',
          name: 'worker-media-1',
          queues: ['image-processing'],
          concurrency: 4,
          hostname: 'worker-02',
          pid: 3987,
          status: 'active',
          registeredAt: now - 5_100_000,
          lastSeen: now - 2_000,
          activeJobs: 2,
          processedJobs: 342,
          failedJobs: 1,
          currentJob: '019f252b-8769-7000-bc44-cfc168232f53',
          uptime: 5_100_000,
        },
        {
          id: 'wrk-c05e881f',
          name: 'worker-batch-1',
          queues: ['reports'],
          concurrency: 2,
          hostname: 'worker-02',
          pid: 4102,
          status: 'stale',
          registeredAt: now - 9_000_000,
          lastSeen: now - 1_200_000,
          activeJobs: 0,
          processedJobs: 57,
          failedJobs: 0,
          currentJob: null,
          uptime: 7_800_000,
        },
      ],
      stats: { total: 3, active: 2, totalProcessed: 1683, totalFailed: 7, activeJobs: 2 },
    },
  };
};

export const demoControlLogs = (): Json => {
  const now = Date.now();
  const line = (seq: number, ago: number, stream: string, value: string) => ({
    seq,
    ts: now - ago,
    stream,
    line: value,
  });
  return {
    lines: [
      line(1, 8000, 'sys', 'starting: bunx bunqueue@2.8.59 start'),
      line(2, 7800, 'stdout', 'bunqueue v2.8.59 — HTTP :6790, TCP :6791'),
      line(3, 7600, 'stdout', 'SQLite ready (WAL) at ./data/bunqueue.db'),
      line(4, 5000, 'stdout', 'worker registered: image-processing'),
      line(5, 1200, 'stdout', 'health ok — 4 queues, 34 jobs'),
    ],
  };
};
