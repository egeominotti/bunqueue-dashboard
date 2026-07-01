import { describe, expect, test } from 'bun:test';
import { persistedS3State } from '../src/components/dashboard/stores/s3Store';

describe('s3Store persistence', () => {
  // Security property: credentials must never appear in the state projection
  // that persist writes to localStorage. Asserting on the pure projection is
  // deterministic and independent of storage availability under bun.
  test('persisted projection excludes AWS credentials, keeps non-secret config', () => {
    const persisted = persistedS3State({
      endpoint: 'https://s3.example',
      region: 'eu-west-1',
      bucket: 'my-bucket',
      accessKeyId: 'AKIAEXAMPLEKEYID',
      secretAccessKey: 'super-secret-do-not-persist',
      schedule: '24h',
      pathPrefix: 'backups/',
      set: () => {},
    });

    expect(persisted).toMatchObject({ bucket: 'my-bucket', region: 'eu-west-1' });
    expect(persisted).not.toHaveProperty('secretAccessKey');
    expect(persisted).not.toHaveProperty('accessKeyId');
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain('super-secret-do-not-persist');
    expect(serialized).not.toContain('AKIAEXAMPLEKEYID');
  });
});
