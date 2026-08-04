import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  ALERTS_STORAGE_KEY,
  MAX_ALERT_CHANNELS,
  MAX_ALERT_RULES,
  sanitizedPersistedAlertsState,
  useAlertsStore,
} from '../src/components/dashboard/stores/alertsStore';
import {
  COPILOT_STORAGE_KEY,
  useCopilotStore,
} from '../src/components/dashboard/stores/copilotStore';
import {
  S3_STORAGE_KEY,
  sanitizedPersistedS3State,
  useS3Store,
} from '../src/components/dashboard/stores/s3Store';

const STORAGE_KEYS = [ALERTS_STORAGE_KEY, S3_STORAGE_KEY, COPILOT_STORAGE_KEY] as const;

function resetStores(): void {
  useAlertsStore.setState({ channels: [], rules: [] });
  useS3Store.setState({
    endpoint: '',
    region: 'us-east-1',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: '',
    schedule: 'disabled',
    pathPrefix: '',
    virtualHostedStyle: 'auto',
    retention: 7,
  });
  useCopilotStore.getState().cancelPending();
  useCopilotStore.setState({
    open: false,
    config: { provider: 'anthropic', baseURL: '', model: 'claude-opus-4-8', apiKey: '' },
    messages: [],
    pending: [],
    busy: false,
  });
  for (const key of STORAGE_KEYS) globalThis.localStorage.removeItem(key);
}

beforeEach(resetStores);
afterEach(resetStores);

describe('alertsStore resilient persistence', () => {
  test('hostile arrays are sanitized and legacy delivery secrets are rewritten away', async () => {
    globalThis.localStorage.setItem(
      ALERTS_STORAGE_KEY,
      JSON.stringify({
        state: {
          channels: [
            { id: 'web', type: 'webhook', target: 'https://hooks.example/LEGACY-SECRET' },
            { id: 'slack', type: 'slack', target: 'https://hooks.slack.test/SECRET' },
            { id: 'mail', type: 'email', target: 'ops@example.com' },
            { id: 'bad-target', type: 'email', target: { address: 'attacker' } },
            { id: 'bad-type', type: 'sms', target: '+39000' },
          ],
          // This exact stale shape used to reach Alerts.tsx and crash at .some().
          rules: 'oops',
          ignored: 'legacy',
        },
        version: 0,
      })
    );

    await useAlertsStore.persist.rehydrate();

    expect(useAlertsStore.getState().channels).toEqual([
      { id: 'web', type: 'webhook', target: '' },
      { id: 'slack', type: 'slack', target: '' },
      { id: 'mail', type: 'email', target: 'ops@example.com' },
    ]);
    expect(useAlertsStore.getState().rules).toEqual([]);
    const raw = globalThis.localStorage.getItem(ALERTS_STORAGE_KEY) as string;
    expect(JSON.parse(raw)).toEqual({
      state: {
        channels: [
          { id: 'web', type: 'webhook', target: '' },
          { id: 'slack', type: 'slack', target: '' },
          { id: 'mail', type: 'email', target: 'ops@example.com' },
        ],
        rules: [],
      },
      version: 1,
    });
    expect(raw).not.toContain('LEGACY-SECRET');
    expect(raw).not.toContain('hooks.slack.test');
  });

  test('invalid enums, booleans and non-finite thresholds are dropped', () => {
    const valid = {
      id: 'r1',
      name: 'DLQ high',
      metric: 'dlq',
      operator: '>=',
      threshold: 2,
      queue: 'orders',
      channel: 'email',
      enabled: true,
    };
    const sanitized = sanitizedPersistedAlertsState({
      channels: [],
      rules: [
        valid,
        { ...valid, id: 'metric', metric: 'arbitrary-code' },
        { ...valid, id: 'operator', operator: '!=' },
        { ...valid, id: 'threshold', threshold: Number.POSITIVE_INFINITY },
        { ...valid, id: 'enabled', enabled: 'yes' },
      ],
    });
    expect(sanitized.rules).toEqual([valid]);
  });

  test('deduplicates bounded IDs and drops semantically invalid alert records', () => {
    const validRule = {
      id: 'rule-0',
      name: 'DLQ high',
      metric: 'dlq',
      operator: '>=',
      threshold: 2,
      queue: 'orders',
      channel: 'email',
      enabled: true,
    } as const;
    const channels = [
      { id: ' ', type: 'email', target: 'blank@example.com' },
      { id: 'mail', type: 'email', target: 'not-an-email' },
      ...Array.from({ length: MAX_ALERT_CHANNELS + 10 }, (_, index) => ({
        id: index === 1 ? ' channel-0 ' : `channel-${index}`,
        type: 'email',
        target: `ops-${index}@example.com`,
      })),
    ];
    const rules = [
      { ...validRule, id: '', name: 'blank id' },
      { ...validRule, id: 'negative', threshold: -1 },
      { ...validRule, id: 'percent', metric: 'error_rate', threshold: 101 },
      ...Array.from({ length: MAX_ALERT_RULES + 10 }, (_, index) => ({
        ...validRule,
        id: index === 1 ? ' rule-0 ' : `rule-${index}`,
        name: `rule ${index}`,
      })),
    ];

    const sanitized = sanitizedPersistedAlertsState({ channels, rules });

    expect(sanitized.channels).toHaveLength(MAX_ALERT_CHANNELS);
    expect(new Set(sanitized.channels.map(({ id }) => id)).size).toBe(MAX_ALERT_CHANNELS);
    expect(sanitized.channels[0]).toEqual({
      id: 'channel-0',
      type: 'email',
      target: 'ops-0@example.com',
    });
    expect(sanitized.rules).toHaveLength(MAX_ALERT_RULES);
    expect(new Set(sanitized.rules.map(({ id }) => id)).size).toBe(MAX_ALERT_RULES);
    expect(sanitized.rules.some(({ id }) => id === 'negative' || id === 'percent')).toBe(false);
  });

  test('runtime setters reject invalid channel targets and always make ID progress', () => {
    const originalNow = Date.now;
    const originalRandom = Math.random;
    Date.now = () => 1;
    Math.random = () => 0;
    try {
      const store = useAlertsStore.getState();
      store.addChannel('email', 'not-an-email');
      store.addChannel('webhook', 'javascript:alert(1)');
      store.addChannel('slack', 'https://user:pass@example.com/hook');
      expect(useAlertsStore.getState().channels).toEqual([]);

      store.addChannel('email', ' first@example.com ');
      useAlertsStore.getState().addChannel('email', 'second@example.com');
      const ids = useAlertsStore.getState().channels.map(({ id }) => id);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
    } finally {
      Date.now = originalNow;
      Math.random = originalRandom;
    }
  });
});

describe('s3Store resilient persistence', () => {
  test('hostile field types fall back safely and legacy AWS credentials are erased', async () => {
    globalThis.localStorage.setItem(
      S3_STORAGE_KEY,
      JSON.stringify({
        state: {
          endpoint: 'https://s3.example',
          region: { hostile: true },
          bucket: {},
          accessKeyId: 'AKIA-LEGACY-SECRET',
          secretAccessKey: 'AWS-LEGACY-SECRET',
          sessionToken: 'AWS-LEGACY-SESSION',
          schedule: 'every-minute',
          pathPrefix: 42,
        },
        version: 0,
      })
    );

    await useS3Store.persist.rehydrate();

    expect(useS3Store.getState()).toMatchObject({
      endpoint: 'https://s3.example',
      region: 'us-east-1',
      bucket: '',
      accessKeyId: '',
      secretAccessKey: '',
      sessionToken: '',
      schedule: 'disabled',
      pathPrefix: '',
      virtualHostedStyle: 'auto',
      retention: 7,
    });
    expect(() => useS3Store.getState().bucket.trim()).not.toThrow();
    const raw = globalThis.localStorage.getItem(S3_STORAGE_KEY) as string;
    expect(JSON.parse(raw)).toEqual({
      state: {
        endpoint: 'https://s3.example',
        region: 'us-east-1',
        bucket: '',
        schedule: 'disabled',
        pathPrefix: '',
        virtualHostedStyle: 'auto',
        retention: 7,
      },
      version: 2,
    });
    expect(raw).not.toContain('AKIA-LEGACY-SECRET');
    expect(raw).not.toContain('AWS-LEGACY-SECRET');
    expect(raw).not.toContain('AWS-LEGACY-SESSION');
  });

  test('the pure sanitizer only accepts strings and supported schedules', () => {
    expect(
      sanitizedPersistedS3State({
        endpoint: null,
        region: 4,
        bucket: [],
        schedule: '1h',
        pathPrefix: false,
      })
    ).toEqual({
      endpoint: '',
      region: 'us-east-1',
      bucket: '',
      schedule: 'disabled',
      pathPrefix: '',
      virtualHostedStyle: 'auto',
      retention: 7,
    });
  });
});
