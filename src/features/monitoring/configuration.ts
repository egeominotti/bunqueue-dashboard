export interface MonitoringInput {
  url: string;
  jobName?: string;
  bearerTokenFile?: boolean;
}

const TOKEN_FILE = '/etc/prometheus/secrets/bunqueue-token';

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
}

function prometheusPath(url: URL): string {
  // Prometheus assigns metrics_path to Go URL.Path, without a matching RawPath.
  // Encoded separators cannot retain their distinct segment/proxy semantics there.
  if (/%(?:2f|5c)/i.test(url.pathname)) {
    throw new Error('Scrape URL must not contain encoded path separators.');
  }
  // Go encodePath emits $ & + , / : ; = @ raw. Decoding these escapes loses
  // their distinction from literal reserved characters (including proxy parameters).
  if (/%(?:24|26|2b|2c|3a|3b|3d|40)/i.test(url.pathname)) {
    throw new Error(
      'Scrape URL contains encoded reserved path characters Prometheus cannot preserve.'
    );
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    throw new Error('Scrape URL path must contain valid UTF-8 percent escapes.');
  }
  if (hasControlCharacters(path)) {
    throw new Error('Scrape URL path must not contain encoded control characters.');
  }
  return path;
}

function configuration(input: MonitoringInput): { url: URL; path: string; jobName: string } {
  if (hasControlCharacters(input.url) || /[?#]/.test(input.url)) {
    throw new Error('Scrape URL must not contain control characters, a query or a fragment.');
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error('Enter an absolute HTTP(S) scrape URL reachable by Prometheus.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Scrape URL must use HTTP(S) without embedded credentials.');
  }
  const jobName = input.jobName ?? 'bunqueue';
  if (!jobName.trim() || jobName.length > 256 || hasControlCharacters(jobName)) {
    throw new Error('Scrape job name must be 1–256 characters without control characters.');
  }
  return { url, path: prometheusPath(url), jobName };
}

export function prometheusScrapeConfig(input: MonitoringInput): string {
  const { url, path, jobName } = configuration(input);
  return [
    'scrape_configs:',
    `  - job_name: ${JSON.stringify(jobName)}`,
    `    scheme: ${JSON.stringify(url.protocol.slice(0, -1))}`,
    `    metrics_path: ${JSON.stringify(path)}`,
    ...(input.bearerTokenFile ? [`    bearer_token_file: ${JSON.stringify(TOKEN_FILE)}`] : []),
    '    static_configs:',
    `      - targets: [${JSON.stringify(url.host)}]`,
    '',
  ].join('\n');
}

export function prometheusAlertRules(input: MonitoringInput): string {
  const { jobName } = configuration(input);
  // PromQL string escaping happens before the complete expression is quoted for YAML.
  const escaped = jobName.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const selector = `{job="${escaped}"}`;
  const examples = [
    ['BunqueueWaitingBacklog', `bunqueue_jobs_waiting${selector} > 1000`, '5m', 'warning'],
    ['BunqueueDeadLetterJobs', `bunqueue_jobs_dlq${selector} > 0`, '5m', 'warning'],
    [
      'BunqueueRecentFailures',
      `increase(bunqueue_jobs_failed_total${selector}[5m]) > 0`,
      '5m',
      'warning',
    ],
    ['BunqueueStorageDegraded', `bunqueue_storage_degraded${selector} == 1`, '1m', 'critical'],
    ['BunqueueDiskFull', `bunqueue_storage_disk_full${selector} == 1`, '1m', 'critical'],
  ];
  return [
    'groups:',
    '  - name: "bunqueue-native-examples"',
    '    rules:',
    ...examples.flatMap(([alert, expr, duration, severity]) => [
      `      - alert: ${JSON.stringify(alert)}`,
      `        expr: ${JSON.stringify(expr)}`,
      `        for: ${JSON.stringify(duration)}`,
      '        labels:',
      `          severity: ${JSON.stringify(severity)}`,
    ]),
    '',
  ].join('\n');
}
