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
});
