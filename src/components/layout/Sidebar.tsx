import { NavLink } from 'react-router-dom';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { useThemeStore } from '@/components/dashboard/stores/themeStore';
import {
  IconCron,
  IconDlq,
  IconEye,
  IconJobs,
  IconLightning,
  IconLogs,
  IconMetrics,
  IconMoon,
  IconOverview,
  IconQueues,
  IconS3,
  IconSettings,
  IconSun,
  IconUsage,
  IconWorkers,
} from '@/components/ui/icons';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePolledData } from '@/lib/usePolledData';
import { SidebarFooter } from './SidebarFooter';

type NavItem = { to: string; label: string; icon: typeof IconOverview; end?: boolean };
type NavGroup = { section: string | null; items: NavItem[] };

const NAV: NavGroup[] = [
  { section: null, items: [{ to: '/', label: 'Overview', icon: IconOverview, end: true }] },
  {
    section: 'Queues',
    items: [
      { to: '/queues', label: 'Queues', icon: IconQueues },
      { to: '/jobs', label: 'Jobs', icon: IconJobs },
      { to: '/dlq', label: 'Dead Letter Queue', icon: IconDlq },
      { to: '/cron', label: 'Cron Jobs', icon: IconCron },
    ],
  },
  {
    section: 'Monitoring',
    items: [
      { to: '/metrics', label: 'Metrics', icon: IconMetrics },
      { to: '/workers', label: 'Workers', icon: IconWorkers },
      { to: '/logs', label: 'Logs', icon: IconLogs },
    ],
  },
  {
    section: 'Control',
    items: [
      { to: '/server', label: 'Server', icon: IconWorkers },
      { to: '/add-job', label: 'Add Job', icon: IconJobs },
      { to: '/job', label: 'Job Inspector', icon: IconEye },
      { to: '/queue-control', label: 'Queue Control', icon: IconQueues },
      { to: '/cron-manager', label: 'Cron Manager', icon: IconCron },
      { to: '/dlq-control', label: 'DLQ Control', icon: IconDlq },
      { to: '/webhooks', label: 'Webhooks', icon: IconLightning },
      { to: '/diagnostics', label: 'Diagnostics', icon: IconMetrics },
    ],
  },
  {
    section: 'Management',
    items: [
      { to: '/usage', label: 'Usage', icon: IconUsage },
      { to: '/s3', label: 'S3 Backup', icon: IconS3 },
      { to: '/settings', label: 'Settings', icon: IconSettings },
    ],
  },
];

function ConnectionBadge() {
  const baseUrl = useConnectionStore((s) => s.baseUrl);
  const { data, error } = usePolledData(() => api.health(), []);
  const ok = !error && data?.ok !== false;
  const host = baseUrl.replace(/^https?:\/\//, '') || 'local';
  return (
    <div className="mx-3 mb-4 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5">
      <span
        className={cn('size-1.5 rounded-full', ok ? 'bg-emerald-400' : 'bg-red-400')}
        title={ok ? 'connected' : 'offline'}
      />
      <span className="truncate font-mono text-[11px] text-muted" title={baseUrl}>
        {host}
      </span>
    </div>
  );
}

function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const toggle = useThemeStore((s) => s.toggle);
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      className="mx-3 mb-3 flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg"
    >
      {dark ? <IconSun className="size-4" /> : <IconMoon className="size-4" />}
      {dark ? 'Light Mode' : 'Dark Mode'}
    </button>
  );
}

export function Sidebar({ open = false, onClose }: { open?: boolean; onClose?: () => void }) {
  return (
    <>
      {/* Mobile overlay behind the drawer. */}
      {open && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
        />
      )}
      <aside
        className={cn(
          'flex w-60 shrink-0 flex-col border-r border-line bg-sidebar',
          // Off-canvas drawer below lg; static column at lg and up.
          'fixed inset-y-0 left-0 z-50 transition-transform lg:static lg:z-auto lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
      >
        <div className="flex items-center gap-2 px-5 py-5">
          <span className="text-lg font-bold tracking-tight text-fg">bunqueue</span>
          <span className="rounded-md bg-accent/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent">
            dash
          </span>
          <span
            title="Beta — under active development"
            className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-400"
          >
            beta
          </span>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {NAV.map((group) => (
            <div key={group.section ?? 'root'} className="mb-4">
              {group.section && (
                <div className="px-2 pb-2 pt-1 text-[10px] font-semibold uppercase tracking-wider text-faint">
                  {group.section}
                </div>
              )}
              <div className="flex flex-col gap-0.5">
                {group.items.map(({ to, label, icon: IconComp, end }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    className={({ isActive }) =>
                      cn(
                        'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-surface-2 text-fg'
                          : 'text-muted hover:bg-surface-2/60 hover:text-fg'
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" />
                        )}
                        <IconComp className="size-[18px] shrink-0" />
                        <span className="truncate">{label}</span>
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <ConnectionBadge />
        <ThemeToggle />
        <SidebarFooter />
      </aside>
    </>
  );
}
