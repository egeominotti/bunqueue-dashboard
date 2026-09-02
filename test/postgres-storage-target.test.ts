import { describe, expect, test } from 'bun:test';
import { managedPostgresTarget, type ServerConfig } from '../agent/manager';

function config(url: string): ServerConfig {
  return {
    command: 'bunqueue',
    httpPort: 6790,
    tcpPort: 6789,
    dataPath: './data/bunqueue.db',
    extraEnv: { BUNQUEUE_POSTGRES_URL: url },
  };
}

describe('credential-free PostgreSQL topology target', () => {
  test('keeps host, effective port and database while removing credentials and query data', () => {
    const target = managedPostgresTarget(
      config('postgresql://operator:p%40ss@db.internal:6543/orders%20queue?sslmode=require')
    );
    expect(target).toBe('db.internal:6543/orders queue');
    expect(target).not.toContain('operator');
    expect(target).not.toContain('sslmode');
  });

  test('uses PostgreSQL defaults and rejects malformed or unrelated schemes', () => {
    expect(managedPostgresTarget(config('postgres://db.internal'))).toBe(
      'db.internal:5432/postgres'
    );
    expect(managedPostgresTarget(config('https://db.internal/bunqueue'))).toBeUndefined();
    expect(managedPostgresTarget(config('postgres:///bunqueue'))).toBeUndefined();
    expect(managedPostgresTarget(config('not a URL'))).toBeUndefined();
  });
});
