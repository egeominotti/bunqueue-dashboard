import { Link } from 'react-router-dom';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { IconSettings } from '@/components/ui/icons';

/** Bottom-of-sidebar identity/connection card (mirrors the reference layout). */
export function SidebarFooter() {
  const baseUrl = useConnectionStore((s) => s.baseUrl);
  const host = baseUrl === '/api' ? 'localhost:6790' : baseUrl.replace(/^https?:\/\//, '');
  return (
    <div className="mx-3 mb-3 flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent to-fuchsia-600 text-[11px] font-bold text-white">
        bq
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-fg">bunqueue</div>
        <div className="truncate font-mono text-[10px] text-faint" title={baseUrl}>
          {host}
        </div>
      </div>
      <Link
        to="/settings"
        aria-label="Settings"
        className="text-faint transition-colors hover:text-fg"
      >
        <IconSettings className="size-4" />
      </Link>
    </div>
  );
}
