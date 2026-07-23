import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { ProcessManager } from '../agent/manager';

describe('ProcessManager', () => {
  test('starts a process and reports running with a pid, then stops', async () => {
    const m = new ProcessManager();
    m.setConfig({ command: 'sleep 30' });
    expect(m.getStatus().status).toBe('stopped');

    await m.start();
    const running = m.getStatus();
    expect(running.status).toBe('running');
    expect(running.pid).toBeGreaterThan(0);

    await m.stop();
    expect(m.getStatus().status).toBe('stopped');
    expect(m.getStatus().pid).toBeNull();
  });

  test('allows editing config while running; change applies on next restart', async () => {
    const m = new ProcessManager();
    m.setConfig({ command: 'sleep 30', httpPort: 6790 });
    await m.start();
    expect(m.getStatus().runningConfig?.httpPort).toBe(6790);

    // Editing while running is allowed (no throw)...
    const cfg = m.setConfig({ httpPort: 7999 });
    expect(cfg.httpPort).toBe(7999);
    // ...but the live process keeps its launch config until a restart.
    expect(m.getStatus().config.httpPort).toBe(7999);
    expect(m.getStatus().runningConfig?.httpPort).toBe(6790);

    await m.stop();
    expect(m.getStatus().runningConfig).toBeNull();
  });

  test('reports SQLite on-disk size for the configured data path', async () => {
    const path = `/tmp/bq-agent-dbstats-${process.pid}.db`;
    await Bun.write(path, 'x'.repeat(256));
    await Bun.write(`${path}-wal`, 'y'.repeat(64));
    try {
      const m = new ProcessManager();
      m.setConfig({ dataPath: path });
      const db = await m.dbStats();
      expect(db.exists).toBe(true);
      expect(db.size).toBe(256);
      expect(db.walSize).toBe(64);
      expect(db.totalSize).toBe(320);
      expect(db.mtimeMs).toBeGreaterThan(0);
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
    }
  });

  test('dbStats reports non-existent db as empty', async () => {
    const m = new ProcessManager();
    m.setConfig({ dataPath: `/tmp/bq-agent-missing-${process.pid}.db` });
    const db = await m.dbStats();
    expect(db.exists).toBe(false);
    expect(db.totalSize).toBe(0);
    expect(db.mtimeMs).toBeNull();
  });

  test('captures child stdout and system log lines', async () => {
    const m = new ProcessManager();
    m.setConfig({ command: 'echo hello-from-test' });
    await m.start();
    await Bun.sleep(300);
    const logs = m.getLogs();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.stream === 'sys')).toBe(true);
    expect(logs.some((l) => l.line.includes('hello-from-test'))).toBe(true);
    await m.stop();
  });

  // The last thing a crashing process writes (its crash cause) often has no
  // trailing newline — the pipe reader must flush the residual buffer on
  // stream end, or that line never reaches the log ring buffer.
  test('captures a final output chunk not terminated by a newline', async () => {
    const m = new ProcessManager();
    m.setConfig({ command: 'printf LASTLINE_NO_NEWLINE' });
    await m.start();
    await Bun.sleep(300);
    expect(m.getLogs().some((l) => l.line.includes('LASTLINE_NO_NEWLINE'))).toBe(true);
    await m.stop();
  });

  // A spawn failure racing an in-flight stop() (whose token is stale, so its
  // finalizer returns early) must still leave a consistent stopped snapshot —
  // not the previous generation's dead pid + non-null runningConfig.
  test('failed spawn leaves no stale pid or runningConfig', async () => {
    const m = new ProcessManager();
    m.setConfig({ command: `/nonexistent-binary-${process.pid} start` });
    await expect(m.start()).rejects.toThrow('Failed to spawn');
    const s = m.getStatus();
    expect(s.status).toBe('stopped');
    expect(s.pid).toBeNull();
    expect(s.runningConfig).toBeNull();
  });

  test('exposes the port/data-path config it will pass through', () => {
    const m = new ProcessManager();
    const cfg = m.setConfig({ httpPort: 7000, tcpPort: 7001, dataPath: '/tmp/x.db' });
    expect(cfg.httpPort).toBe(7000);
    expect(cfg.tcpPort).toBe(7001);
    expect(cfg.dataPath).toBe('/tmp/x.db');
  });

  // Race: a stop() in flight must not clobber a process a concurrent start()
  // brought up. stop() sets status='stopping' then awaits the old process's
  // exit; if start() runs in that window and the old proc's onExit (or stop()'s
  // own tail) unconditionally nulls this.proc, the freshly-started process is
  // orphaned and the manager wrongly reports 'stopped'.
  test('concurrent stop-then-start does not orphan the newly started process', async () => {
    const m = new ProcessManager();
    m.setConfig({ command: 'sleep 30' });
    await m.start();
    const pid1 = m.getStatus().pid;
    expect(pid1).toBeGreaterThan(0);

    // Begin stop but do NOT await — it SIGTERMs proc1 and awaits its exit.
    const stopping = m.stop();
    // Race a start in while status === 'stopping'.
    await m.start();
    // Let the stop settle (proc1 already terminated).
    await stopping;

    const final = m.getStatus();
    expect(final.status).toBe('running');
    expect(final.pid).toBeGreaterThan(0);
    expect(final.pid).not.toBe(pid1);

    await m.stop();
    expect(m.getStatus().status).toBe('stopped');
    expect(m.getStatus().pid).toBeNull();
  });

  // …and the converse invariant: the replacement must not be spawned while the
  // outgoing child is still alive, or two bunqueue servers briefly fight over
  // the same ports and SQLite db.
  test('start racing an in-flight stop waits for the old child to exit', async () => {
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const m = new ProcessManager();
    m.setConfig({ command: 'sleep 30' });
    await m.start();
    const pid1 = m.getStatus().pid as number;

    const stopping = m.stop();
    await m.start();
    const pid2 = m.getStatus().pid as number;
    expect(pid2).not.toBe(pid1);
    expect(alive(pid1)).toBe(false);

    await stopping;
    await m.stop();
  });

  // An invalid command must leave the manager exactly as it was: the old code
  // bumped procToken and set status BEFORE validating, so the empty-command
  // throw stranded the previous generation's dead pid + runningConfig (both
  // finalizers were already token-stale and returned early).
  test('empty command rejects without stranding a pid or runningConfig', async () => {
    const m = new ProcessManager();
    m.setConfig({ command: 'sleep 30' });
    await m.start();

    const stopping = m.stop();
    m.setConfig({ command: '   ' });
    await expect(m.start()).rejects.toThrow('Empty command');
    await stopping;

    const s = m.getStatus();
    expect(s.status).toBe('stopped');
    expect(s.pid).toBeNull();
    expect(s.runningConfig).toBeNull();
  });

  // PUT /control/config casts the JSON body straight to Partial<ServerConfig>,
  // so `{"command": null}` reaches the manager. `.trim()` on it used to throw a
  // TypeError with status already pinned at 'starting' — an unrecoverable wedge
  // (the guard short-circuits every later start, and the UI disables all three
  // controls while 'starting').
  test('a non-string command does not wedge status at starting', async () => {
    const m = new ProcessManager();
    m.setConfig({ command: null as unknown as string });
    await expect(m.start()).rejects.toThrow('Empty command');
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
});
