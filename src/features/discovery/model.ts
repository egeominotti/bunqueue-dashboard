import type { ConnectionProfileTarget } from '@/components/dashboard/stores/connectionStore';
import type { DlqEntryFull, JobFull } from '@/lib/bqTypes';

export interface DiscoveryQuery {
  text?: string;
  profiles?: string[];
  queue?: string;
  state?: string;
  createdAfter?: number;
  createdBefore?: number;
  minPriority?: number;
  includeDlq?: boolean;
}
export interface DiscoveryRow {
  source: Readonly<ConnectionProfileTarget>;
  queue: string;
  state: string;
  job: JobFull;
  dlq?: DlqEntryFull;
}
export interface ScanLimits {
  queues: number;
  jobs: number;
  requests: number;
  milliseconds: number;
  results: number;
}
export interface ProfileCoverage {
  profileId: string;
  profileName: string;
  status: 'complete' | 'partial' | 'error' | 'skipped';
  queues: number;
  inspectedJobs: number;
  discoveredQueues?: number;
  errors: string[];
}
export interface ScanReport {
  rows: DiscoveryRow[];
  coverage: ProfileCoverage[];
  inspectedJobs: number;
  scannedQueues: number;
  requests: number;
  matches: number;
  partial: boolean;
  cancelled: boolean;
  limitsHit: (keyof ScanLimits)[];
  elapsedMs: number;
}
