import { Link, useLocation } from 'react-router-dom';
import { IconMenu } from '@/components/ui/icons';

const TITLES: Record<string, string> = {
  '/': 'Overview',
  '/queues': 'Queues',
  '/jobs': 'Jobs',
  '/dlq': 'Dead Letter Queue',
  '/cron': 'Cron Jobs',
  '/metrics': 'Metrics',
  '/workers': 'Workers',
  '/logs': 'Logs',
  '/server': 'Server',
  '/add-job': 'Add Job',
  '/job': 'Job Inspector',
  '/queue-control': 'Queue Control',
  '/cron-manager': 'Cron Manager',
  '/dlq-control': 'DLQ Control',
  '/webhooks': 'Webhooks',
  '/diagnostics': 'Diagnostics',
  '/benchmark': 'Benchmark',
  '/usage': 'Usage',
  '/s3': 'S3 Backup',
  '/settings': 'Settings',
};

function titleFor(pathname: string): string {
  if (TITLES[pathname]) return TITLES[pathname];
  if (pathname.startsWith('/queues/')) {
    // A pasted/hand-typed URL may carry a malformed percent-escape (e.g. `%zz`),
    // which makes decodeURIComponent throw during render. Fall back to the raw slice.
    let name = pathname.slice(8);
    try {
      name = decodeURIComponent(name);
    } catch {}
    return `${name} · Queue`;
  }
  return 'bunqueue';
}

export function Topbar({ onMenu }: { onMenu?: () => void }) {
  const { pathname } = useLocation();
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-line bg-bg/80 px-4 backdrop-blur sm:px-6 lg:px-8">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          aria-label="Open navigation"
          onClick={onMenu}
          className="-ml-1 flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg lg:hidden"
        >
          <IconMenu className="size-5" />
        </button>
        <div className="truncate text-sm text-muted">
          <span className="text-faint">{titleFor(pathname)}</span>
          <span className="mx-2 hidden text-faint sm:inline">·</span>
          <span className="hidden text-faint sm:inline">bunqueue</span>
        </div>
      </div>
      <Link
        to="/settings"
        title="Settings"
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent to-fuchsia-600 text-xs font-bold text-white"
      >
        bq
      </Link>
    </header>
  );
}
