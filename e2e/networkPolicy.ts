import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { E2E_HTTP_PORT, E2E_TCP_PORT } from './config';

export function acceptsTcpConnection(
  host: string,
  port: number,
  timeoutMs = 500
): Promise<boolean> {
  return new Promise((resolveConnection) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (accepted: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveConnection(accepted);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function externalIpv4Addresses(): string[] {
  return [
    ...new Set(
      Object.values(networkInterfaces()).flatMap((entries) =>
        (entries ?? [])
          .filter((entry) => entry.family === 'IPv4' && !entry.internal)
          .map((entry) => entry.address)
      )
    ),
  ];
}

export async function assertUpstreamIsLoopbackOnly(): Promise<void> {
  const externalAddresses = externalIpv4Addresses();
  if (externalAddresses.length === 0) {
    console.warn('No external IPv4 interface is available for the browser E2E bind probe');
    return;
  }

  const probes = externalAddresses.flatMap((host) =>
    [E2E_HTTP_PORT, E2E_TCP_PORT].map(async (port) => ({
      host,
      port,
      reachable: await acceptsTcpConnection(host, port),
    }))
  );
  const exposed = (await Promise.all(probes)).filter((probe) => probe.reachable);
  if (exposed.length > 0) {
    const listeners = exposed.map(({ host, port }) => `${host}:${port}`).join(', ');
    throw new Error(`Browser E2E upstream escaped loopback: ${listeners}`);
  }
}
