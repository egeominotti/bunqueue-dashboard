import {
  bulkSummary,
  describe,
  expect,
  test,
  validateBulkItems,
} from './mutating-forms-fixes.helpers';

describe('BulkAddJobs', () => {
  test('spec validation blocks silent option loss and invalid relationships', () => {
    expect(validateBulkItems([{ data: {}, unexpected: true }], {}, 'spec').ok).toBe(false);
    expect(validateBulkItems([{ data: {}, priority: 1.5 }], {}, 'spec').ok).toBe(false);
    expect(validateBulkItems([{ data: {}, repeat: { pattern: '0 9 * * *' } }], {}, 'spec').ok).toBe(
      false
    );
    expect(
      validateBulkItems(
        [{ data: {}, uniqueKey: 'u', dedup: { ttl: 1000, typo: true } }],
        {},
        'spec'
      ).ok
    ).toBe(false);
    for (const unsafe of [
      'parentId',
      'childrenIds',
      'failParentOnFailure',
      'removeDependencyOnFailure',
      'continueParentOnFailure',
      'ignoreDependencyOnFailure',
      'keepLogs',
      'sizeLimit',
      'debounceId',
      'debounceTtl',
    ]) {
      expect(validateBulkItems([{ data: {}, [unsafe]: true }], {}, 'spec').ok).toBe(false);
    }
    expect(validateBulkItems([{ data: {}, jobId: 'a', customId: 'b' }], {}, 'spec').ok).toBe(false);
    expect(
      validateBulkItems(
        [
          { data: {}, jobId: 'a', dependsOn: ['b'] },
          { data: {}, jobId: 'b', dependsOn: ['a'] },
        ],
        {},
        'spec'
      ).ok
    ).toBe(false);
    expect(
      validateBulkItems(
        [
          { data: {}, jobId: 'duplicate' },
          { data: {}, customId: 'duplicate' },
        ],
        {},
        'spec'
      ).ok
    ).toBe(false);
  });

  test('valid full specs survive validation as the exact request bodies', () => {
    const parsed = validateBulkItems(
      [
        {
          data: { order: 1 },
          priority: '5',
          customId: 99,
          uniqueKey: 'order-99',
          repeat: { every: 1000, limit: 2 },
          dedup: { ttl: 5000, replace: true },
          dependsOn: ['external-parent'],
          stallTimeout: 30_000,
          stackTraceLimit: 25,
          timestamp: 123456789,
        },
      ],
      {},
      'spec'
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.bodies[0]).toMatchObject({
        data: { order: 1 },
        priority: 5,
        jobId: '99',
        uniqueKey: 'order-99',
        repeat: { every: 1000, limit: 2 },
        dedup: { ttl: 5000, replace: true },
        dependsOn: ['external-parent'],
        stallTimeout: 30_000,
        stackTraceLimit: 25,
        timestamp: 123456789,
      });
    }
  });

  test('bulk import describes accepted submissions and distinct ids', () => {
    expect(bulkSummary(2, 2, 'orders')).toEqual({
      ok: true,
      msg: 'Accepted 2 job submissions in orders; server returned 2 distinct job IDs (deduplication may reuse existing jobs)',
    });
    const short = bulkSummary(497, 500, 'orders');
    expect(short.ok).toBe(true);
    expect(short.msg).toContain('Accepted 500 job submissions');
    expect(short.msg).toContain('497 distinct job IDs');
    expect(short.msg).not.toContain('Created');
  });
});
