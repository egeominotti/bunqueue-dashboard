import { describe, expect, test } from 'bun:test';
import {
  FLOW_BULK_RETRY_UNAVAILABLE,
  FLOW_COMPLETED_REQUEUE_UNAVAILABLE,
  FLOW_DELETION_UNAVAILABLE,
  FLOW_DLQ_RETENTION_UNAVAILABLE,
  FLOW_DLQ_RETRY_UNAVAILABLE,
  retryStandaloneDlqJob,
  standaloneDlqRetryError,
} from '../src/lib/flowMutationSafety';

describe('flow mutation fail-closed boundary', () => {
  test('publishes a reason for every unavailable destructive surface', () => {
    const versionedReasons = [
      FLOW_DELETION_UNAVAILABLE,
      FLOW_BULK_RETRY_UNAVAILABLE,
      FLOW_COMPLETED_REQUEUE_UNAVAILABLE,
    ];
    for (const reason of versionedReasons) {
      expect(reason).toContain('Bunqueue v2.9.3');
    }
    expect(FLOW_DLQ_RETENTION_UNAVAILABLE).toContain('read-only');
    expect(FLOW_DLQ_RETENTION_UNAVAILABLE).toContain('atomic reverse-dependency check');
    expect(FLOW_DLQ_RETRY_UNAVAILABLE).toBe(FLOW_BULK_RETRY_UNAVAILABLE);
  });

  test('never treats a stale job snapshot as authorization to retry', () => {
    const reason = standaloneDlqRetryError(
      { id: 'reused-id', queue: 'orders', state: 'failed' },
      'orders',
      'reused-id'
    );
    expect(reason).toBe(FLOW_DLQ_RETRY_UNAVAILABLE);
    expect(standaloneDlqRetryError(null, 'orders', 'missing')).toBe(reason);
  });

  test('the compatibility retry helper throws before any transport can run', async () => {
    expect(() => retryStandaloneDlqJob('orders', 'reused-id')).toThrow(FLOW_DLQ_RETRY_UNAVAILABLE);
    await expect(
      Promise.resolve().then(() => retryStandaloneDlqJob('orders', 'reused-id'))
    ).rejects.toThrow(FLOW_DLQ_RETRY_UNAVAILABLE);
  });
});
