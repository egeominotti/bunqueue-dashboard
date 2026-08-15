type RuntimeChild = Pick<ReturnType<typeof Bun.spawn>, 'exitCode'>;

interface TargetValidationOptions {
  dashboardUrl: string;
  basePath: string;
  child: RuntimeChild;
}

const startupTimeoutMs = 30_000;

/** Exercise the installed tarball's real target-pinned agent routes below BASE_PATH. */
export async function validatePrefixedAgentTargets({
  dashboardUrl,
  basePath,
  child,
}: TargetValidationOptions): Promise<void> {
  const bridge = `${dashboardUrl}${basePath}/agent`;
  const target = encodeURIComponent(`${basePath}/api`);
  let started = false;
  try {
    const start = await requestJson(`${bridge}/control/start`, child, { method: 'POST' });
    assert(start.response.ok, `Managed server start returned HTTP ${start.response.status}`);
    started = true;
    await waitForPackageResponse(`${dashboardUrl}${basePath}/api/health`, child);

    const checks = [
      ['Flow', `${bridge}/flows/tree?id=missing&queueName=package-smoke&target=${target}`],
      ['Workflow', `${bridge}/workflows/runtime?target=${target}`],
      ['Queue', `${bridge}/queue-operations/package-smoke/limits?target=${target}`],
    ] as const;
    for (const [label, url] of checks) {
      const result = await requestJson(url, child);
      assert(result.response.ok, `${label} target route returned HTTP ${result.response.status}`);
      assert(result.body.ok === true, `${label} target route did not acknowledge success`);
    }
    const backup = await requestJson(`${bridge}/backup/configure?target=${target}`, child, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ environment: { S3_BACKUP_ENABLED: 'false' } }),
    });
    assert(backup.body.ok === true, 'Backup target route did not acknowledge success');
  } finally {
    if (started) {
      const stop = await requestJson(`${bridge}/control/stop`, child, { method: 'POST' });
      assert(stop.response.ok, `Managed server stop returned HTTP ${stop.response.status}`);
    }
  }
}

export async function readPackageAgentStatus(
  url: string,
  child: RuntimeChild
): Promise<Record<string, unknown>> {
  const response = await waitForPackageResponse(url, child);
  assert(
    response.headers.get('content-type')?.includes('application/json'),
    `Control agent returned a non-JSON response from ${url}`
  );
  const body: unknown = await response.json();
  assert(isRecord(body) && isRecord(body.config), `Control agent returned invalid status from ${url}`);
  return body;
}

export async function waitForPackageResponse(
  url: string,
  child: RuntimeChild
): Promise<Response> {
  const deadline = Date.now() + startupTimeoutMs;
  let lastFailure = 'no response';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Published bin exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return response;
      lastFailure = `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastFailure}`);
}

async function requestJson(
  url: string,
  child: RuntimeChild,
  init?: RequestInit
): Promise<{ response: Response; body: Record<string, unknown> }> {
  if (child.exitCode !== null) throw new Error(`Published bin exited with code ${child.exitCode}`);
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
  const value: unknown = await response.json();
  assert(isRecord(value), `Target route returned invalid JSON from ${url}`);
  if (!response.ok) {
    throw new Error(`Target route failed at ${url}: HTTP ${response.status} ${JSON.stringify(value)}`);
  }
  return { response, body: value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
