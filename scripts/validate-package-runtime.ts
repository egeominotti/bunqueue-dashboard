import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  readPackageAgentStatus,
  validatePrefixedAgentTargets,
  waitForPackageResponse,
} from './validate-package-targets';

const repository = resolve(import.meta.dir, '..');
const commandTimeoutMs = 4 * 60_000;
const shutdownTimeoutMs = 5_000;

type Child = ReturnType<typeof Bun.spawn>;
type CapturedChild = { child: Child; stdout: Promise<string>; stderr: Promise<string> };

async function main(): Promise<void> {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'bunqueue-dashboard-package-')));
  const packDirectory = join(scratch, 'pack');
  const consumerDirectory = join(scratch, 'consumer');
  let runtime: CapturedChild | undefined;
  let failure: unknown;
  let runtimeOutput: { stdout: string; stderr: string } | undefined;

  try {
    await Promise.all([mkdir(packDirectory), mkdir(consumerDirectory)]);
    await runCommand(
      ['npm', 'pack', '--ignore-scripts=false', '--pack-destination', packDirectory],
      repository,
      commandTimeoutMs
    );
    const tarball = await onlyTarball(packDirectory);
    await writeFile(
      join(consumerDirectory, 'package.json'),
      `${JSON.stringify({ name: 'package-runtime-smoke', private: true }, null, 2)}\n`
    );
    await runCommand(
      [
        'npm',
        'install',
        '--ignore-scripts=true',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        tarball,
      ],
      consumerDirectory,
      commandTimeoutMs
    );

    const packageDirectory = await installedPackageDirectory(consumerDirectory, scratch);
    await assertPublishedRuntimeClosure(packageDirectory);
    const [dashboardPort, agentPort, httpPort, tcpPort] = await allocatePorts(4);
    const bin = join(
      consumerDirectory,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'bunqueue-dashboard.cmd' : 'bunqueue-dashboard'
    );
    await access(bin, constants.X_OK);
    runtime = spawnRuntime(
      bin,
      consumerDirectory,
      scratch,
      dashboardPort,
      agentPort,
      httpPort,
      tcpPort
    );

    const dashboardUrl = `http://127.0.0.1:${dashboardPort}`;
    const basePath = '/internal/queue';
    const agentUrl = `http://127.0.0.1:${agentPort}`;
    const dashboard = await waitForPackageResponse(
      `${dashboardUrl}${basePath}/`,
      runtime.child
    );
    const html = await dashboard.text();
    assert(
      html.includes('<div id="root"></div>') &&
        html.includes(`window.__BUNQUEUE_AGENT_URL__="${basePath}/agent"`) &&
        html.includes(`src="${basePath}/assets/`),
      'Published dashboard did not serve the embedded application shell'
    );
    assert(
      dashboard.headers.get('x-content-type-options') === 'nosniff',
      'Published dashboard did not apply runtime security headers'
    );

    const directAgent = await readPackageAgentStatus(`${agentUrl}/control/status`, runtime.child);
    const bridgedAgent = await readPackageAgentStatus(
      `${dashboardUrl}${basePath}/agent/control/status`,
      runtime.child
    );
    assert(
      directAgent.status === 'stopped' && bridgedAgent.status === 'stopped',
      'Published control agent returned an unexpected initial status'
    );
    await validatePrefixedAgentTargets({ dashboardUrl, basePath, child: runtime.child });

    console.log(JSON.stringify({
      tarball: basename(tarball),
      packageDirectory,
      dashboard: `${dashboardUrl}${basePath}/`,
      agent: `${agentUrl}/control/status`,
      bridge: `${dashboardUrl}${basePath}/agent/control/status`,
      targetRoutes: ['Flow', 'Workflow', 'Queue', 'Backup'],
      status: 'ok',
    }, null, 2));
  } catch (error) {
    failure = error;
  } finally {
    if (runtime) {
      try {
        await terminate(runtime.child);
        runtimeOutput = {
          stdout: await runtime.stdout,
          stderr: await runtime.stderr,
        };
      } catch (error) {
        failure ??= error;
      }
    }
    await rm(scratch, { recursive: true, force: true });
  }

  if (failure) {
    const logs = runtimeOutput
      ? `\nRuntime stdout:\n${tail(runtimeOutput.stdout)}\nRuntime stderr:\n${tail(runtimeOutput.stderr)}`
      : '';
    throw new Error(`Package runtime smoke failed: ${messageOf(failure)}${logs}`);
  }
}

async function onlyTarball(directory: string): Promise<string> {
  const tarballs = (await readdir(directory)).filter((entry) => entry.endsWith('.tgz'));
  assert(tarballs.length === 1, `Expected one npm tarball, found ${tarballs.length}`);
  return join(directory, tarballs[0]);
}

async function installedPackageDirectory(consumer: string, scratch: string): Promise<string> {
  const directory = await realpath(join(consumer, 'node_modules', 'bunqueue-dashboard'));
  assert(
    directory.startsWith(`${scratch}/`),
    `npm installed the package outside the isolated consumer: ${directory}`
  );
  return directory;
}

async function assertPublishedRuntimeClosure(packageDirectory: string): Promise<void> {
  const required = ['serve.ts', 'serveHandler.ts', 'servePolicy.ts', 'embedded.gen.ts'];
  await Promise.all(
    required.map(async (fileName) => {
      const relativePath = `scripts/${fileName}`;
      try {
        await access(join(packageDirectory, relativePath));
      } catch {
        throw new Error(`Published package is missing ${relativePath}`);
      }
    })
  );
}

function spawnRuntime(
  bin: string,
  cwd: string,
  scratch: string,
  dashboardPort: number,
  agentPort: number,
  httpPort: number,
  tcpPort: number
): CapturedChild {
  const child = Bun.spawn([bin], {
    cwd,
    env: {
      ...process.env,
      AGENT_ALLOWED_HOSTS: '',
      AGENT_ALLOWED_ORIGINS: '',
      AGENT_PORT: String(agentPort),
      AGENT_TOKEN: '',
      BASE_PATH: '/internal/queue',
      BIND_ADDR: '127.0.0.1',
      BUNQUEUE_DATA_PATH: join(scratch, 'runtime.db'),
      BUNQUEUE_TOKEN: '',
      BUNQUEUE_URL: `http://127.0.0.1:${httpPort}`,
      HTTP_PORT: String(httpPort),
      PORT: String(dashboardPort),
      TCP_PORT: String(tcpPort),
      TRUST_PROXY: '0',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  };
}

async function allocatePorts(count: number): Promise<number[]> {
  const servers: Server[] = [];
  try {
    for (let index = 0; index < count; index++) {
      const server = createServer();
      await new Promise<void>((resolveReady, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolveReady);
      });
      servers.push(server);
    }
    return servers.map((server) => {
      const address = server.address();
      assert(address && typeof address !== 'string', 'Could not allocate an ephemeral port');
      return address.port;
    });
  } finally {
    await Promise.all(
      servers.map(
        (server) => new Promise<void>((resolveClosed) => server.close(() => resolveClosed()))
      )
    );
  }
}

async function runCommand(command: string[], cwd: string, timeoutMs: number): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timedOut = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => child.kill('SIGKILL'), shutdownTimeoutMs);
  }, timeoutMs);
  const exitCode = await child.exited;
  clearTimeout(timer);
  clearTimeout(forceTimer);
  const output = { stdout: await stdout, stderr: await stderr };
  if (timedOut) {
    throw new Error(`Command timed out: ${command.join(' ')}\n${tail(output.stderr)}`);
  }
  if (exitCode !== 0) {
    throw new Error(
      `Command failed (${exitCode}): ${command.join(' ')}\n${tail(output.stdout)}\n${tail(output.stderr)}`
    );
  }
}

async function terminate(child: Child): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  if (await exitsWithin(child, shutdownTimeoutMs)) return;
  child.kill('SIGKILL');
  if (!(await exitsWithin(child, shutdownTimeoutMs))) {
    throw new Error(`Published bin pid ${child.pid} did not exit after SIGKILL`);
  }
}

async function exitsWithin(child: Child, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    child.exited.then(() => true),
    new Promise<boolean>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tail(value: string): string {
  return value.slice(-4_000).trim();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
