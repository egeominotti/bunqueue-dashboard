import { type BulkJobBody, bulkJobPayloadBudgetError } from '@/lib/bq';
import { utf8ByteLength } from '../addJob/data';
import { MAX_BULK_INPUT_BYTES, MAX_BULK_INPUT_CHARS, MAX_BULK_PAYLOAD_BYTES } from './constants';

export function bulkInputBudgetError(text: string): string | null {
  if (
    text.length > MAX_BULK_INPUT_CHARS ||
    utf8ByteLength(text, MAX_BULK_INPUT_BYTES) > MAX_BULK_INPUT_BYTES
  ) {
    return 'Import text exceeds the 64 MiB UTF-8 safety limit';
  }
  return null;
}

export function bulkPayloadBudgetError(
  bodies: BulkJobBody[],
  maxBytes = MAX_BULK_PAYLOAD_BYTES
): string | null {
  return bulkJobPayloadBudgetError(bodies, maxBytes);
}

export function bulkSummary(
  distinctIds: number,
  submitted: number,
  queue: string
): { ok: boolean; msg: string } {
  return {
    ok: true,
    msg: `Accepted ${submitted} job submission${submitted === 1 ? '' : 's'} in ${queue}; server returned ${distinctIds} distinct job ID${distinctIds === 1 ? '' : 's'} (deduplication may reuse existing jobs)`,
  };
}

export function parseInput(text: string): { items: unknown[]; error: string | null } {
  const budgetError = bulkInputBudgetError(text);
  if (budgetError) return { items: [], error: budgetError };
  const trimmed = text.trim();
  if (!trimmed) return { items: [], error: null };
  try {
    const parsed = JSON.parse(trimmed);
    return { items: Array.isArray(parsed) ? parsed : [parsed], error: null };
  } catch {
    // Fall through to newline-delimited JSON.
  }
  const items: unknown[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      items.push(JSON.parse(line));
    } catch (error) {
      return { items: [], error: `Line ${index + 1}: ${(error as Error).message}` };
    }
  }
  return { items, error: null };
}
