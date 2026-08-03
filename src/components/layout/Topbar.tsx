import { Link, useLocation } from 'react-router-dom';
import { IconMenu, IconSearch } from '@/components/ui/icons';
import { isDemo } from '@/lib/demo/isDemo';
import { titleFor, useDocumentTitle } from './pageTitle';

const DEMO = isDemo();

export function Topbar({
  onMenu,
  navOpen = false,
}: {
  onMenu?: (opener: HTMLButtonElement) => void;
  navOpen?: boolean;
}) {
  const { pathname } = useLocation();
  const pageTitle = titleFor(pathname);
  useDocumentTitle(pageTitle);
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-line bg-bg/80 px-4 backdrop-blur sm:px-6 lg:px-8">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          aria-label="Open navigation"
          aria-expanded={navOpen}
          aria-controls="app-nav"
          onClick={(event) => onMenu?.(event.currentTarget)}
          className="-ml-1 flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 lg:hidden"
        >
          <IconMenu className="size-5" />
        </button>
        <div className="truncate text-sm text-muted">
          <span className="text-faint">{pageTitle}</span>
          <span className="mx-2 hidden text-faint sm:inline">·</span>
          <span className="hidden text-faint sm:inline">bunqueue</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {DEMO && (
          <span
            title="Showing canned sample data. No real bunqueue server is connected."
            className="hidden items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent sm:inline-flex"
          >
            <span className="size-1.5 rounded-full bg-accent" />
            Live demo
          </span>
        )}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('command-palette:open'))}
          title="Command palette"
          aria-label="Open command palette"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:hidden"
        >
          <IconSearch className="size-5" />
        </button>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('command-palette:open'))}
          title="Command palette (⌘K)"
          aria-label="Open command palette"
          className="hidden items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:flex"
        >
          <span>Search</span>
          <kbd className="rounded border border-line bg-surface-2 px-1 font-mono text-[10px]">
            ⌘K
          </kbd>
        </button>
        <Link
          to="/settings"
          title="Settings"
          aria-label="Open settings"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent to-fuchsia-600 text-xs font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          bq
        </Link>
      </div>
    </header>
  );
}
