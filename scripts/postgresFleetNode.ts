import { join } from 'node:path';
import { freePort } from './flowRuntimeSupport';

export type NodeRuntime = {
  name: string;
  httpPort: number;
  tcpPort: number;
  agentPort: number;
  serverToken: string;
  agentToken: string;
  child: ReturnType<typeof Bun.spawn>;
  stdout: Promise<string>;
  stderr: Promise<string>;
};

export async function spawnPostgresFleetNode(
  index: number,
  options: {
    repository: string;
    root: string;
    cli: string;
    namespace: string;
    postgresUrl: string;
    corsAllowOrigin?: string;
  }
): Promise<NodeRuntime> {
  const [httpPort, tcpPort, agentPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const name = `broker-${index + 1}`;
  const serverToken = `server-token-${index + 1}`;
  const agentToken = `agent-token-${index + 1}`;
  const child = Bun.spawn(['bun', 'run', 'agent/index.ts'], {
    cwd: options.repository,
    env: {
      ...process.env,
      AGENT_ALLOWED_HOSTS: '',
      AGENT_ALLOWED_ORIGINS: options.corsAllowOrigin ?? '',
      AGENT_PORT: String(agentPort),
      AGENT_TOKEN: agentToken,
      AUTH_TOKENS: serverToken,
      BUNQUEUE_DATA_PATH: join(options.root, `${name}-workflow.db`),
      BUNQUEUE_MANAGED: '1',
      BUNQUEUE_POSTGRES_NAMESPACE: options.namespace,
      BUNQUEUE_POSTGRES_POOL_SIZE: '4',
      BUNQUEUE_POSTGRES_URL: options.postgresUrl,
      BUNQUEUE_START_CMD: `bun ${options.cli} start`,
      BUNQUEUE_STORAGE_DRIVER: 'postgres',
      BUNQUEUE_TOKEN: serverToken,
      BUNQUEUE_URL: `http://127.0.0.1:${httpPort}`,
      ...(options.corsAllowOrigin ? { CORS_ALLOW_ORIGIN: options.corsAllowOrigin } : {}),
      HTTP_PORT: String(httpPort),
      TCP_PORT: String(tcpPort),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    name,
    httpPort,
    tcpPort,
    agentPort,
    serverToken,
    agentToken,
    child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  };
}
