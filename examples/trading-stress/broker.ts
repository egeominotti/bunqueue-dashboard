import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assert } from './model';
async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolveReady, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolveReady);
  });
  const address = socket.address();
  assert(address && typeof address !== 'string', 'Impossibile allocare una porta libera');
  const port = address.port;
  await new Promise<void>((resolveClose) => socket.close(() => resolveClose()));
  return port;
}

export const tempRoot = await mkdtemp(join(tmpdir(), 'bunqueue-trading-stress-'));
const dataPath = join(tempRoot, 'stress.db');
export const tcpPort = await freePort();
export let httpPort = await freePort();
while (httpPort === tcpPort) httpPort = await freePort();

let broker: ReturnType<typeof Bun.spawn> | null = null;

function spawnBroker() {
  return Bun.spawn(
    [
      'bun',
      resolve('node_modules/bunqueue/dist/cli/index.js'),
      'start',
      '--host',
      '127.0.0.1',
      '--tcp-port',
      String(tcpPort),
      '--http-port',
      String(httpPort),
      '--data-path',
      dataPath,
    ],
    { stdout: 'ignore', stderr: 'ignore' }
  );
}

export async function startBroker(): Promise<void> {
  broker = spawnBroker();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (broker.exitCode !== null)
      throw new Error(`Bunqueue terminato con codice ${broker.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${httpPort}/ready`);
      if (response.ok) return;
    } catch {
      // Il broker sta ancora aprendo le porte.
    }
    await Bun.sleep(25);
  }
  throw new Error('Timeout durante l’avvio del broker Bunqueue');
}

export async function stopBroker(): Promise<void> {
  if (broker?.exitCode !== null) return;
  broker.kill('SIGTERM');
  await Promise.race([broker.exited, Bun.sleep(5_000)]);
  if (broker.exitCode === null) {
    broker.kill('SIGKILL');
    await broker.exited;
  }
}
