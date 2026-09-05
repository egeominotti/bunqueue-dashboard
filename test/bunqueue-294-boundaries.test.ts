import { describe, expect, test } from 'bun:test';
import { routeFlowRequest } from '../agent/flow/routes';
import { mutateFlowJob } from '../agent/flow/service';
import type { FlowMutationOperation } from '../agent/flow/types';
import type { ServerConfig } from '../agent/manager';
import { verifyBunqueueVersion } from '../scripts/bunqueueRuntimeVersion';
import { bqFlowOperationsRepository } from '../src/features/flows/infrastructure/bqFlowOperationsRepository';
import { assertFlowOperationState } from '../src/lib/flowOperationPolicy';

const config: ServerConfig = {
  command: 'unused',
  httpPort: 6790,
  tcpPort: 1,
  dataPath: '/unused',
  extraEnv: {},
};
const blocked: FlowMutationOperation[] = [
  'updateData',
  'retry',
  'remove',
  'removeUnprocessedChildren',
];

describe('Bunqueue 2.9.4 flow boundaries', () => {
  for (const operation of blocked) {
    test(`${operation} is refused by UI transport, route and direct service before broker access`, async () => {
      const target = { id: 'job', queueName: 'queue' };
      expect(() => bqFlowOperationsRepository.mutate(target, operation, {})).toThrow();
      await expect(mutateFlowJob(config, target, operation, {})).rejects.toThrow(
        /read-only|unavailable/
      );
      const path = `/flows/jobs/job/${operation}`;
      const request = new Request(`http://agent${path}?queueName=queue&target=%2Fapi`, {
        method: 'POST',
        ...(operation === 'updateData' ? { body: '{"data":{}}' } : {}),
      });
      await expect(routeFlowRequest(request, path, 'POST', config)).rejects.toThrow(
        /read-only|unavailable/
      );
    });
  }

  test('priority, delay and promotion follow the ordinary job state policy', () => {
    for (const state of ['active', 'completed', 'failed', 'waiting-children']) {
      for (const operation of ['changePriority', 'changeDelay', 'promote']) {
        expect(() => assertFlowOperationState(operation, state)).toThrow('unavailable');
      }
    }
    expect(() => assertFlowOperationState('changePriority', 'waiting')).not.toThrow();
    expect(() => assertFlowOperationState('promote', 'delayed')).not.toThrow();
  });
});

test('runtime version checks reject stale or absent health versions', () => {
  expect(verifyBunqueueVersion('2.9.4', '2.9.4')).toBe('2.9.4');
  for (const actual of ['2.9.3', undefined, 294]) {
    expect(() => verifyBunqueueVersion(actual, '2.9.4')).toThrow('version mismatch');
  }
});
