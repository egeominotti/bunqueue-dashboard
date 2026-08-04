import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ALERTS_STORAGE_KEY, useAlertsStore } from '../src/components/dashboard/stores/alertsStore';
import {
  COPILOT_STORAGE_KEY,
  sanitizedPersistedCopilotState,
  useCopilotStore,
} from '../src/components/dashboard/stores/copilotStore';
import { S3_STORAGE_KEY, useS3Store } from '../src/components/dashboard/stores/s3Store';

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

describe('copilotStore resilient persistence', () => {
  test('valid setup survives while a legacy API key and transient state are erased', async () => {
    globalThis.localStorage.setItem(
      COPILOT_STORAGE_KEY,
      JSON.stringify({
        state: {
          config: {
            provider: 'custom',
            baseURL: 'https://llm.example/v1',
            model: 'local-model',
            apiKey: 'sk-LEGACY-SECRET',
          },
          messages: [{ role: 'user', content: 'sensitive queue data' }],
          pending: [{ name: 'purge_dlq' }],
          busy: true,
        },
        version: 0,
      })
    );

    await useCopilotStore.persist.rehydrate();

    expect(useCopilotStore.getState().config).toEqual({
      provider: 'custom',
      baseURL: 'https://llm.example/v1',
      model: 'local-model',
      apiKey: '',
    });
    expect(useCopilotStore.getState().messages).toEqual([]);
    expect(useCopilotStore.getState().pending).toEqual([]);
    expect(useCopilotStore.getState().busy).toBe(false);
    const raw = globalThis.localStorage.getItem(COPILOT_STORAGE_KEY) as string;
    expect(JSON.parse(raw)).toEqual({
      state: {
        config: {
          provider: 'custom',
          baseURL: 'https://llm.example/v1',
          model: 'local-model',
        },
      },
      version: 1,
    });
    expect(raw).not.toContain('sk-LEGACY-SECRET');
    expect(raw).not.toContain('sensitive queue data');
    expect(raw).not.toContain('purge_dlq');
  });

  test('unknown providers and hostile config fields fail closed to defaults', async () => {
    globalThis.localStorage.setItem(
      COPILOT_STORAGE_KEY,
      JSON.stringify({
        state: {
          config: {
            provider: 'anthropic-v2',
            baseURL: { toString: 'https://collector.example' },
            model: ['wrong-shape'],
            apiKey: 'secret',
          },
        },
        version: 1,
      })
    );

    await useCopilotStore.persist.rehydrate();

    expect(useCopilotStore.getState().config).toEqual({
      provider: 'anthropic',
      baseURL: '',
      model: 'claude-opus-4-8',
      apiKey: '',
    });
    expect(
      sanitizedPersistedCopilotState({ config: { provider: Symbol('bad'), apiKey: 'secret' } })
    ).toEqual({
      config: { provider: 'anthropic', baseURL: '', model: 'claude-opus-4-8' },
    });
    expect(globalThis.localStorage.getItem(COPILOT_STORAGE_KEY)).not.toContain('secret');
  });
});

describe('persisted stores tolerate unavailable browser storage', () => {
  test('a failed canonical rewrite deletes legacy secret blobs instead of retaining them', async () => {
    const storage = globalThis.localStorage;
    storage.setItem(
      ALERTS_STORAGE_KEY,
      JSON.stringify({
        state: {
          channels: [{ id: 'web', type: 'webhook', target: 'ALERT-SECRET' }],
          rules: [],
        },
        version: 0,
      })
    );
    storage.setItem(
      S3_STORAGE_KEY,
      JSON.stringify({
        state: { accessKeyId: 'AWS-KEY', secretAccessKey: 'AWS-SECRET' },
        version: 0,
      })
    );
    storage.setItem(
      COPILOT_STORAGE_KEY,
      JSON.stringify({
        state: {
          config: {
            provider: 'anthropic',
            baseURL: '',
            model: 'claude-opus-4-8',
            apiKey: 'COPILOT-SECRET',
          },
        },
        version: 0,
      })
    );
    const original = Object.getOwnPropertyDescriptor(storage, 'setItem');
    Object.defineProperty(storage, 'setItem', {
      configurable: true,
      value: () => {
        const error = new Error('canonical rewrite denied');
        error.name = 'QuotaExceededError';
        throw error;
      },
    });
    try {
      await useAlertsStore.persist.rehydrate();
      await useS3Store.persist.rehydrate();
      await useCopilotStore.persist.rehydrate();
      expect(storage.getItem(ALERTS_STORAGE_KEY)).toBeNull();
      expect(storage.getItem(S3_STORAGE_KEY)).toBeNull();
      expect(storage.getItem(COPILOT_STORAGE_KEY)).toBeNull();
      expect(useAlertsStore.getState().channels[0]?.target).toBe('');
      expect(useS3Store.getState()).toMatchObject({ accessKeyId: '', secretAccessKey: '' });
      expect(useCopilotStore.getState().config.apiKey).toBe('');
    } finally {
      if (original) Object.defineProperty(storage, 'setItem', original);
      else Reflect.deleteProperty(storage, 'setItem');
    }
  });

  test('QuotaExceededError from setItem never rolls back the in-memory setter', () => {
    const storage = globalThis.localStorage;
    const original = Object.getOwnPropertyDescriptor(storage, 'setItem');
    Object.defineProperty(storage, 'setItem', {
      configurable: true,
      value: () => {
        const error = new Error('quota reached');
        error.name = 'QuotaExceededError';
        throw error;
      },
    });
    try {
      expect(() => useAlertsStore.getState().addChannel('email', 'ops@example.com')).not.toThrow();
      expect(() => useS3Store.getState().set({ bucket: 'memory-only' })).not.toThrow();
      expect(() =>
        useCopilotStore.getState().setConfig({ model: 'memory-model', apiKey: 'session-key' })
      ).not.toThrow();

      expect(useAlertsStore.getState().channels[0]?.target).toBe('ops@example.com');
      expect(useS3Store.getState().bucket).toBe('memory-only');
      expect(useCopilotStore.getState().config).toMatchObject({
        model: 'memory-model',
        apiKey: 'session-key',
      });
    } finally {
      if (original) Object.defineProperty(storage, 'setItem', original);
      else Reflect.deleteProperty(storage, 'setItem');
    }
  });

  test('SecurityError from getItem is absorbed by every rehydration path', async () => {
    const storage = globalThis.localStorage;
    const original = Object.getOwnPropertyDescriptor(storage, 'getItem');
    Object.defineProperty(storage, 'getItem', {
      configurable: true,
      value: () => {
        const error = new Error('storage denied');
        error.name = 'SecurityError';
        throw error;
      },
    });
    try {
      await useAlertsStore.persist.rehydrate();
      await useS3Store.persist.rehydrate();
      await useCopilotStore.persist.rehydrate();
      expect(useAlertsStore.getState().rules).toEqual([]);
      expect(useS3Store.getState().bucket).toBe('');
      expect(useCopilotStore.getState().config.provider).toBe('anthropic');
    } finally {
      if (original) Object.defineProperty(storage, 'getItem', original);
      else Reflect.deleteProperty(storage, 'getItem');
    }
  });

  test('malformed JSON plus a failing removeItem still falls back without throwing', async () => {
    const storage = globalThis.localStorage;
    for (const key of STORAGE_KEYS) storage.setItem(key, '{not-json');
    const original = Object.getOwnPropertyDescriptor(storage, 'removeItem');
    Object.defineProperty(storage, 'removeItem', {
      configurable: true,
      value: () => {
        const error = new Error('cleanup denied');
        error.name = 'SecurityError';
        throw error;
      },
    });
    try {
      await useAlertsStore.persist.rehydrate();
      await useS3Store.persist.rehydrate();
      await useCopilotStore.persist.rehydrate();
      expect(useAlertsStore.getState().channels).toEqual([]);
      expect(useS3Store.getState().schedule).toBe('disabled');
      expect(useCopilotStore.getState().config.apiKey).toBe('');
    } finally {
      if (original) Object.defineProperty(storage, 'removeItem', original);
      else Reflect.deleteProperty(storage, 'removeItem');
    }
  });
});
