import { describe, expect, test } from 'bun:test';
import type { AgentFetchHandler } from '../agent/server';
import { createAgentShutdown } from '../agent/shutdown';

describe('agent signal shutdown', () => {
  test('stops accepting and starts child shutdown so an upstream stream can drain', async () => {
    const events: string[] = [];
    const exits: number[] = [];
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const handle = shutdownHandle(events);
    handle.shutdown = async () => {
      events.push('handler:shutdown');
      releaseDrain();
    };
    const signal = createAgentShutdown(handle, {
      graceMs: 10_000,
      exit: (code) => exits.push(code),
      stopAccepting: [
        () => {
          events.push('listener:stop');
          return drain;
        },
      ],
    });

    signal('SIGTERM');
    await eventually(() => exits.length === 1);

    expect(events).toEqual(['listener:stop', 'handler:begin', 'handler:shutdown']);
    expect(exits).toEqual([0]);
  });

  test('returns a failing exit code after a drain or shutdown failure', async () => {
    const events: string[] = [];
    const exits: number[] = [];
    const handle = shutdownHandle(events, Promise.reject(new Error('resource close failed')));
    const signal = createAgentShutdown(handle, {
      graceMs: 10_000,
      exit: (code) => exits.push(code),
      stopAccepting: [() => Promise.reject(new Error('listener drain failed'))],
    });

    signal('SIGINT');
    await eventually(() => exits.length === 1);

    expect(events).toEqual(['handler:begin', 'handler:shutdown']);
    expect(exits).toEqual([1]);
  });

  test('does not lose an initial admission-close rejection if later shutdown resolves', async () => {
    const events: string[] = [];
    const exits: number[] = [];
    const handle = shutdownHandle(events);
    handle.beginShutdown = () => {
      events.push('handler:begin');
      return Promise.reject(undefined);
    };
    const signal = createAgentShutdown(handle, {
      graceMs: 10_000,
      exit: (code) => exits.push(code),
    });

    signal('SIGTERM');
    await eventually(() => exits.length === 1);

    expect(events).toEqual(['handler:begin', 'handler:shutdown']);
    expect(exits).toEqual([1]);
  });

  test('a second signal force-stops the managed child before exiting one', () => {
    const events: string[] = [];
    const exits: number[] = [];
    const never = new Promise<void>(() => {});
    const handle = shutdownHandle(events, never);
    const signal = createAgentShutdown(handle, {
      graceMs: 10_000,
      exit: (code) => exits.push(code),
      stopAccepting: [() => never],
    });

    signal('SIGTERM');
    signal('SIGTERM');

    expect(events).toEqual(['handler:begin', 'handler:shutdown', 'handler:force']);
    expect(exits).toEqual([1]);
  });

  test('a JSON-unsafe force failure cannot suppress or duplicate forced exit', () => {
    const events: string[] = [];
    const exits: number[] = [];
    const never = new Promise<void>(() => {});
    const handle = shutdownHandle(events, never);
    handle.forceShutdown = () => {
      events.push('handler:force');
      throw hostileError();
    };
    const signal = createAgentShutdown(handle, {
      graceMs: 10_000,
      exit: (code) => exits.push(code),
    });

    signal('SIGTERM');
    signal('SIGTERM');
    signal('SIGTERM');

    expect(events).toEqual(['handler:begin', 'handler:shutdown', 'handler:force']);
    expect(exits).toEqual([1]);
  });

  test('grace expiry force-stops the managed child and exits one', async () => {
    const events: string[] = [];
    const exits: number[] = [];
    const never = new Promise<void>(() => {});
    const signal = createAgentShutdown(shutdownHandle(events, never), {
      graceMs: 5,
      exit: (code) => exits.push(code),
      stopAccepting: [() => never],
    });

    signal('SIGTERM');
    await eventually(() => exits.length === 1);

    expect(events).toEqual(['handler:begin', 'handler:shutdown', 'handler:force']);
    expect(exits).toEqual([1]);
  });

  for (const [label, failure] of hostileFailures()) {
    test(`JSON-unsafe ${label} fields cannot delay or duplicate shutdown`, async () => {
      const events: string[] = [];
      const exits: number[] = [];
      const signal = createAgentShutdown(shutdownHandle(events, Promise.reject(failure)), {
        graceMs: 50,
        exit: (code) => exits.push(code),
      });

      signal('SIGTERM');
      await eventually(() => exits.length === 1);
      await Bun.sleep(60);

      expect(events).toEqual(['handler:begin', 'handler:shutdown']);
      expect(exits).toEqual([1]);
    });
  }
});

function shutdownHandle(events: string[], shutdown = Promise.resolve()): AgentFetchHandler {
  const handle = (async () => new Response()) as AgentFetchHandler;
  handle.close = async () => undefined;
  handle.beginShutdown = () => {
    events.push('handler:begin');
    return shutdown;
  };
  handle.shutdown = () => {
    events.push('handler:shutdown');
    return shutdown;
  };
  handle.forceShutdown = () => {
    events.push('handler:force');
  };
  return handle;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
    await Bun.sleep(1);
  }
  expect(predicate()).toBeTrue();
}

function hostileFailures(): Array<[string, Error]> {
  const inner = hostileError();
  const aggregate = new AggregateError([inner], 'aggregate failure');
  Object.defineProperties(aggregate, {
    name: { value: 4n },
    message: { value: 5n },
    stack: { value: 6n },
  });
  return [
    ['Error', inner],
    ['AggregateError', aggregate],
  ];
}

function hostileError(): Error {
  const error = new Error('hostile failure');
  Object.defineProperties(error, {
    name: { value: 1n },
    message: { value: 2n },
    stack: { value: 3n },
  });
  return error;
}
