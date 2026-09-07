import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const image = 'minio/minio:RELEASE.2025-04-22T22-12-26Z';

export async function startMinio() {
  const name = `bunqueue-ui-s3-${randomUUID()}`;
  const existing = await exec('docker', ['image', 'inspect', image]).then(
    () => true,
    () => false
  );
  let created = false;
  const cleanup = async () => {
    try {
      if (created) await exec('docker', ['rm', '-f', name]);
    } finally {
      if (!existing) {
        const present = await exec('docker', ['image', 'inspect', image]).then(
          () => true,
          () => false
        );
        if (present) await exec('docker', ['image', 'rm', image]);
      }
    }
  };
  try {
    await exec('docker', [
      'run',
      '--rm',
      '-d',
      '--name',
      name,
      '--cpus',
      '2',
      '--memory',
      '512m',
      '-p',
      '127.0.0.1:49390:9000',
      '-e',
      'MINIO_ROOT_USER=dashboard-test',
      '-e',
      'MINIO_ROOT_PASSWORD=dashboard-local-test-password',
      image,
      'server',
      '/data',
    ]);
    created = true;
    // Only an empty bucket directory inside this disposable MinIO instance.
    await exec('docker', ['exec', name, 'mkdir', '-p', '/data/dashboard-backups']);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const ready = await fetch('http://127.0.0.1:49390/minio/health/ready', {
        signal: AbortSignal.timeout(1_000),
      }).then(
        (r) => r.ok,
        () => false
      );
      if (ready) {
        const environment = await exec('docker', [
          'image',
          'inspect',
          image,
          '--format',
          '{{.Id}} {{.Os}}/{{.Architecture}}',
        ]);
        return {
          cleanup,
          environment: environment.stdout.trim(),
          logs: () => exec('docker', ['logs', name]),
        };
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('Local MinIO readiness timed out');
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'MinIO startup and cleanup failed');
    }
    throw error;
  }
}
