import { Link } from 'react-router-dom';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { CopyButton } from '@/components/ui/CopyButton';
import { IconSettings } from '@/components/ui/icons';
import { isDemo } from '@/lib/demo/isDemo';

const REPO_URL = 'https://github.com/egeominotti/bunqueue-dashboard';
const DOCS_URL = 'https://egeominotti.github.io/bunqueue-dashboard/docs/';
const INSTALL_CMD = 'bunx bunqueue-dashboard';

/**
 * Demo-only conversion prompt: the hosted demo is the project's most-shared
 * surface, so give a wowed visitor a path to install / star / read the docs
 * instead of leaving them at a dead end. Only rendered under isDemo().
 */
function DemoCta() {
  return (
    <div className="mx-3 mb-2 rounded-lg border border-accent/30 bg-accent/5 p-3">
      <p className="mb-2 text-[11px] font-medium leading-snug text-fg">
        Like it? Run it on your own bunqueue server.
      </p>
      <div className="mb-2 flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1">
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">{INSTALL_CMD}</code>
        <CopyButton value={INSTALL_CMD} />
      </div>
      <div className="flex items-center gap-2">
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="flex flex-1 items-center justify-center gap-1 rounded-md bg-accent px-2 py-1.5 text-[11px] font-semibold text-accent-fg transition-opacity hover:opacity-90"
        >
          <span aria-hidden>★</span> Star
        </a>
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="flex flex-1 items-center justify-center rounded-md border border-line px-2 py-1.5 text-[11px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          Docs
        </a>
      </div>
    </div>
  );
}

/** Bottom-of-sidebar identity/connection card (mirrors the reference layout). */
export function SidebarFooter() {
  const baseUrl = useConnectionStore((s) => s.baseUrl);
  const host = baseUrl === '/api' ? 'localhost:6790' : baseUrl.replace(/^https?:\/\//, '');
  return (
    <>
      {isDemo() && <DemoCta />}
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
    </>
  );
}
