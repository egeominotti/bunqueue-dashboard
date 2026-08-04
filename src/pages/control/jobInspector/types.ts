export type LookupMode = 'id' | 'custom';

export interface JobLookupTarget {
  baseUrl: string;
  authorization?: string;
}

export interface JobLookupOptions {
  signal?: AbortSignal;
  target?: JobLookupTarget;
  /** Test seam; production retains the same 30s deadline as the shared client. */
  timeoutMs?: number;
}

export interface InspectorResult {
  fetched: boolean;
  value: unknown;
}

export interface InspectorMessage {
  ok: boolean;
  text: string;
}

export type JobAction = (
  label: string,
  operation: () => Promise<unknown>,
  confirmMessage?: string
) => Promise<void>;

export type SetSearchParams = (
  values: Record<string, string>,
  options?: { replace?: boolean }
) => void;
