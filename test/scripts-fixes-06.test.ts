import {
  describe,
  expect,
  it,
  join,
  mkdtempSync,
  mock,
  readFileSync,
  tmpdir,
  writeFileSync,
} from './scripts-fixes.helpers';

describe('serve.ts terminal startup ordering', () => {
  it('finishes awaited setup and registers signals before opening either listener', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'scripts', 'serve.ts'), 'utf8');
    const install = source.indexOf('installAgentShutdown(localAgentHandle');
    const agentServer = source.indexOf('const agentServer = Bun.serve');
    const dashboardRegistered = source.indexOf('stopAccepting.push(() => dashboardServer.stop())');

    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(agentServer);
    expect(source.slice(agentServer, dashboardRegistered)).not.toContain('await ');
  });
});

describe('dev.ts spawn failure', () => {
  it('kills already-spawned children when a later spawn throws', async () => {
    const killed: string[] = [];
    const commands: unknown[] = [];
    const realSpawn = Bun.spawn;
    const realExit = process.exit;
    let calls = 0;
    // @ts-expect-error — test double for Bun.spawn
    Bun.spawn = mock((command: unknown) => {
      commands.push(command);
      calls += 1;
      if (calls === 2) throw new Error('spawn ENOENT');
      return {
        kill: (sig?: string) => killed.push(String(sig ?? 'SIGTERM')),
        exited: Promise.resolve(0),
        exitCode: 0,
        signalCode: null,
      };
    });
    let code: number | undefined;
    // @ts-expect-error — shutdown() ends the process; capture instead.
    process.exit = (c?: number) => {
      code = c;
      throw new Error('__exit__');
    };
    try {
      const { spawnServices } = await import('../scripts/dev');
      await spawnServices().catch((e: Error) => {
        if (e.message !== '__exit__') throw e;
      });
    } finally {
      Bun.spawn = realSpawn;
      process.exit = realExit;
    }
    expect(calls).toBe(2);
    expect(commands).toEqual([
      ['bun', 'agent/index.ts'],
      ['bun', 'node_modules/.bin/vite'],
    ]);
    expect(killed.length).toBeGreaterThan(0); // the agent child was torn down
    expect(code).toBe(1);
  });
});

describe('check-coverage.ts', () => {
  const run = async (lcov: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'lcov-'));
    const file = join(dir, 'lcov.info');
    writeFileSync(file, lcov);
    const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'scripts', 'check-coverage.ts')], {
      env: { ...process.env, LCOV_PATH: file },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return await proc.exited;
  };

  it('fails on a malformed lcov instead of passing with NaN', async () => {
    expect(await run('SF:a.ts\nLF:oops\nLH:1\nFNF:2\nFNH:2\nend_of_record\n')).toBe(1);
  });

  it('fails on an empty lcov', async () => {
    expect(await run('')).toBe(1);
  });

  it('passes a well-formed report above the floor', async () => {
    expect(await run('SF:a.ts\nLF:100\nLH:99\nFNF:10\nFNH:10\nend_of_record\n')).toBe(0);
  });
});
