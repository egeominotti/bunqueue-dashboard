import { describe, expect, test } from 'bun:test';
import {
  type AlertRule,
  type Channel,
  persistedAlertsState,
} from '../src/components/dashboard/stores/alertsStore';

describe('alertsStore persistence', () => {
  // Security property: a webhook/slack channel target is a secret URL and must
  // not be written to localStorage in plaintext (same policy as the connection
  // token and the S3 keys). Asserting on the pure projection is deterministic.
  test('persisted projection blanks secret channel targets, keeps email + rules', () => {
    const channels: Channel[] = [
      { id: 'c1', type: 'webhook', target: 'https://hooks.example/secret-abc123' },
      { id: 'c2', type: 'slack', target: 'https://hooks.slack.com/services/T/B/secretXYZ' },
      { id: 'c3', type: 'email', target: 'ops@example.com' },
    ];
    const rules: AlertRule[] = [
      {
        id: 'r1',
        name: 'high dlq',
        metric: 'dlq',
        operator: '>=',
        threshold: 10,
        queue: 'emails',
        channel: 'webhook',
        enabled: true,
      },
    ];

    const persisted = persistedAlertsState({
      channels,
      rules,
      addChannel: () => {},
      removeChannel: () => {},
      addRule: () => {},
      removeRule: () => {},
      toggleRule: () => {},
    });

    // Rules survive; channel identities survive; only secret targets are blanked.
    expect(persisted.rules).toEqual(rules);
    expect(persisted.channels.find((c) => c.id === 'c1')?.target).toBe('');
    expect(persisted.channels.find((c) => c.id === 'c2')?.target).toBe('');
    expect(persisted.channels.find((c) => c.id === 'c3')?.target).toBe('ops@example.com');

    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain('secret-abc123');
    expect(serialized).not.toContain('secretXYZ');
  });
});
