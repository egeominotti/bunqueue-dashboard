import { describe, expect, test } from 'bun:test';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { bqQueueOperationsRepository } from '../src/features/queue-operations/infrastructure/bqQueueOperationsRepository';
import './domSetup';

const INSTALL_PATH = `${import.meta.dir}/../src/lib/demo/install.ts`;

describe('demo Queue SDK backend', () => {
  test('serves all eight agent contracts without escaping to the network', async () => {
    const previousHref = window.location.href;
    const previousWindowFetch = window.fetch;
    const previousGlobalFetch = globalThis.fetch;
    const connection = useConnectionStore.getState();
    const escaped: string[] = [];
    window.location.href = 'http://localhost:5273/queue-control?demo';
    window.fetch = (async (input: RequestInfo | URL) => {
      escaped.push(String(input));
      throw new Error('Demo request escaped to the network');
    }) as typeof window.fetch;
    const installModule = (await import(
      `${INSTALL_PATH}?queue-sdk=${encodeURIComponent(import.meta.file)}`
    )) as { installDemo: () => () => void };
    const uninstall = installModule.installDemo();
    globalThis.fetch = window.fetch;
    useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });

    try {
      expect(await bqQueueOperationsRepository.limits('image-processing')).toEqual({
        rateLimit: { max: 100, duration: 60_000 },
        concurrency: 4,
        rateLimitTtl: 750,
        maxed: false,
      });
      expect(await bqQueueOperationsRepository.limits('image-processing', 101)).toEqual({
        rateLimit: { max: 100, duration: 60_000 },
        concurrency: 4,
        rateLimitTtl: 0,
        maxed: false,
      });

      expect(
        await bqQueueOperationsRepository.deduplicationJobId('image-processing', 'asset:hero')
      ).toBe('019f252b-8769-7000-bc44-cfc168232f53');
      expect(
        await bqQueueOperationsRepository.metrics('image-processing', 'completed', 1, 2)
      ).toEqual({
        meta: { count: 29, prevTS: 1_783_035_039_000, prevCount: 7 },
        data: [9, 4],
        count: 5,
      });
      expect(
        await bqQueueOperationsRepository.metrics('image-processing', 'failed', 0, -1)
      ).toEqual({
        meta: { count: 2, prevTS: 1_783_035_039_000, prevCount: 0 },
        data: [0, 1, 0, 0, 1],
        count: 5,
      });

      expect(
        await bqQueueOperationsRepository.removeDeduplicationKey('image-processing', 'asset:hero')
      ).toBe(1);
      expect(
        await bqQueueOperationsRepository.deduplicationJobId('image-processing', 'asset:hero')
      ).toBeNull();
      expect(
        await bqQueueOperationsRepository.removeDeduplicationKey('image-processing', 'asset:hero')
      ).toBe(0);
      expect(await bqQueueOperationsRepository.trimEvents('image-processing', 1_000)).toBe(428);
      expect(await bqQueueOperationsRepository.trimEvents('image-processing', 1_000)).toBe(0);

      const malformed = await window.fetch(
        'http://localhost:6800/queue-operations/image-processing/events/trim?target=%2Fapi',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxLength: -1 }),
        }
      );
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({
        ok: false,
        error: 'maxLength must be an integer from 0 to 1000000',
      });
      expect(escaped).toEqual([]);
    } finally {
      globalThis.fetch = previousGlobalFetch;
      uninstall();
      window.fetch = previousWindowFetch;
      window.location.href = previousHref;
      useConnectionStore.setState({
        baseUrl: connection.baseUrl,
        token: connection.token,
        agentToken: connection.agentToken,
      });
    }
  });
});
