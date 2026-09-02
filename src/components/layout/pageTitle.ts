import { useEffect } from 'react';

const TITLES: Record<string, string> = {
  '/': 'Overview',
  '/fleet': 'Fleet',
  '/queues': 'Queues',
  '/jobs': 'Jobs',
  '/dlq': 'Dead Letter Queue',
  '/cron': 'Cron Jobs',
  '/flows': 'Flows',
  '/workflows': 'Workflow · Overview',
  '/workflows/executions': 'Workflow · Executions',
  '/workflows/waiting': 'Workflow · Waiting & Signals',
  '/workflows/compensation': 'Workflow · Compensation',
  '/workflows/archive': 'Workflow · Archive',
  '/metrics': 'Metrics',
  '/workers': 'Workers',
  '/logs': 'Logs',
  '/server': 'Server',
  '/add-job': 'Add Job',
  '/jobs/bulk-add': 'Bulk Add Jobs',
  '/job': 'Job Inspector',
  '/queue-control': 'Queue Control',
  '/dlq-control': 'DLQ Control',
  '/webhooks': 'Webhooks',
  '/diagnostics': 'Diagnostics',
  '/alerts': 'Alerts',
  '/benchmark': 'Benchmark',
  '/database': 'Database',
  '/mcp': 'MCP',
  '/usage': 'Usage',
  '/s3': 'S3 Backup',
  '/settings': 'Settings',
  '/overview-classic': 'Overview (classic)',
  '/queues-classic': 'Queues (classic)',
  '/jobs-classic': 'Jobs (classic)',
  '/dlq-classic': 'DLQ (classic)',
  '/cron-classic': 'Cron Jobs (classic)',
  '/metrics-classic': 'Metrics (classic)',
  '/workers-classic': 'Workers (classic)',
  '/logs-classic': 'Logs (classic)',
  '/usage-classic': 'Usage (classic)',
  '/s3-classic': 'S3 Backup (classic)',
};

export function titleFor(pathname: string): string {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (TITLES[normalized]) return TITLES[normalized];
  const classic = normalized.startsWith('/queues-classic/');
  if (classic || normalized.startsWith('/queues/')) {
    // A pasted/hand-typed URL may carry a malformed percent-escape (e.g. `%zz`),
    // which makes decodeURIComponent throw during render. Fall back to the raw slice.
    let name = normalized.slice(classic ? '/queues-classic/'.length : '/queues/'.length);
    try {
      name = decodeURIComponent(name);
    } catch {}
    return `${name} · Queue${classic ? ' (classic)' : ''}`;
  }
  return 'Page not found';
}

export function useDocumentTitle(pageTitle: string): void {
  useEffect(() => {
    document.title = `${pageTitle} · bunqueue`;
  }, [pageTitle]);
}
