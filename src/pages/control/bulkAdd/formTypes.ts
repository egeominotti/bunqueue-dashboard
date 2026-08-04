import type { ParseMode } from './coercion';

export interface BulkFormValues {
  queue: string;
  text: string;
  mode: ParseMode;
  priority: string;
  maxAttempts: string;
  backoff: string;
  timeout: string;
}

export type SetBulkFormValue = <K extends keyof BulkFormValues>(
  key: K,
  value: BulkFormValues[K]
) => void;

export type BulkResult = { ok: boolean; msg: string } | null;
