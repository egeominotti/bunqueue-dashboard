import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { ProcessManager, type ServerConfig } from '../agent/manager';

describe('ProcessManager', () => {
  test('start validates invalid port defaults read from the environment before changing status', async () => {
    const managerWithEnv = (key: 'HTTP_PORT' | 'TCP_PORT', value: string) => {
      const previous = process.env[key];
      process.env[key] = value;
      try {
        return new ProcessManager();
      } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    };

    const badHttp = managerWithEnv('HTTP_PORT', '70000');
    await expect(badHttp.start()).rejects.toThrow('httpPort');
    expect(badHttp.getStatus()).toMatchObject({ status: 'stopped', pid: null });

    const badTcp = managerWithEnv('TCP_PORT', '12.5');
    await expect(badTcp.start()).rejects.toThrow('tcpPort');
    expect(badTcp.getStatus()).toMatchObject({ status: 'stopped', pid: null });
  });

  test('a rejected config cannot wedge the manager at starting', async () => {
    const m = new ProcessManager();
    expect(() => m.setConfig({ command: null } as unknown as Partial<ServerConfig>)).toThrow(
      'command'
    );
    expect(m.getStatus().status).toBe('stopped');

    m.setConfig({ command: 'sleep 30' });
    await m.start();
    expect(m.getStatus().status).toBe('running');
    await m.stop();
  });

  // extraEnv used to be spread AFTER the injected ports, so a user key named
  // HTTP_PORT moved the child while runningConfig (and the agent's /health
  // probe, which reads it) kept reporting the port nobody was listening on.
  test('extraEnv cannot override the ports runningConfig advertises', async () => {
    const m = new ProcessManager();
    m.setConfig({
      command: 'printenv HTTP_PORT',
      httpPort: 6790,
      extraEnv: { HTTP_PORT: '7000' },
    });
    const started = await m.start();
    expect(started.runningConfig?.httpPort).toBe(6790);
    await Bun.sleep(300);
    // …and the child really received that port, not the extraEnv one.
    expect(m.getLogs().some((l) => l.stream === 'stdout' && l.line.trim() === '6790')).toBe(true);
    await m.stop();
  });

  // The reader's line buffer only shrank at a '\n', and the ring buffer trims by
  // COUNT — so a child dumping a newline-free blob grew the agent's heap to the
  // full output size and then kept it as one giant LogLine.
  test('newline-free child output is capped instead of buffered whole', async () => {
    const script = `/tmp/bq-agent-bigout-${process.pid}.ts`;
    await Bun.write(script, "process.stdout.write('x'.repeat(200000));\n");
    try {
      const m = new ProcessManager();
      m.setConfig({ command: `${process.execPath} ${script}` });
      await m.start();
      await Bun.sleep(1500);
      const longest = Math.max(0, ...m.getLogs().map((l) => l.line.length));
      expect(longest).toBeLessThanOrEqual(8192 + 32);
      await m.stop();
    } finally {
      rmSync(script, { force: true });
    }
  });

  // Ctrl-C on the agent calls shutdown(): a plain stop() racing an in-flight
  // restart() returns successfully *because* restart's start() already spawned a
  // replacement, which process.exit(0) would then orphan on the ports + db.
  test('shutdown() racing an in-flight restart leaves nothing running', async () => {
    const m = new ProcessManager();
    m.setConfig({ command: 'sleep 30' });
    await m.start();

    const restarting = m.restart();
    await Bun.sleep(0);
    await m.shutdown();
    await restarting;

    expect(m.getStatus().status).toBe('stopped');
    expect(m.getStatus().pid).toBeNull();

    // The latch is permanent — nothing can spawn after shutdown.
    await m.start();
    expect(m.getStatus().status).toBe('stopped');
    expect(m.getStatus().pid).toBeNull();
  });

  test('forceShutdown kills the child and permanently prevents replacement', async () => {
    const m = new ProcessManager();
    m.setConfig({ command: 'sleep 30' });
    await m.start();
    const exited = waitUntilStopped(m);

    m.forceShutdown();
    await exited;
    await m.start();

    expect(m.getStatus()).toMatchObject({ status: 'stopped', pid: null });
  });

  test('never reports stopped or forgets a child that remains alive after SIGKILL', async () => {
    const mutableBun = Bun as unknown as { spawn: (...args: unknown[]) => unknown };
    const realSpawn = mutableBun.spawn;
    const kills: Array<number | undefined> = [];
    const never = new Promise<number>(() => {});
    mutableBun.spawn = () => ({
      pid: 91_337,
      stdout: closedStream(),
      stderr: closedStream(),
      exited: never,
      kill: (signal?: number) => kills.push(signal),
    });
    const manager = new ProcessManager(2);
    manager.setConfig({ command: 'synthetic-unkillable-child' });

    try {
      await manager.start();
      await expect(manager.shutdown()).rejects.toThrow('did not exit after SIGKILL');
      expect(manager.getStatus()).toMatchObject({ status: 'stopping', pid: 91_337 });
      expect(kills).toEqual([undefined, 9]);
      await expect(manager.start()).resolves.toMatchObject({ status: 'stopping', pid: 91_337 });
    } finally {
      mutableBun.spawn = realSpawn;
    }
  });
});

async function waitUntilStopped(manager: ProcessManager): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (manager.getStatus().status === 'stopped') return;
    await Bun.sleep(10);
  }
  throw new Error('Managed child did not stop');
}

function closedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}
