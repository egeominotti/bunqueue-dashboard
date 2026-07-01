import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

export function AppLayout() {
  // Mobile nav drawer state. On lg+ the sidebar is always visible and this is
  // ignored; below lg it slides the sidebar in as an overlay.
  const [navOpen, setNavOpen] = useState(false);
  const { pathname } = useLocation();

  // Close the drawer whenever the route changes (tapping a nav item navigates).
  // biome-ignore lint/correctness/useExhaustiveDependencies: close on navigation
  useEffect(() => setNavOpen(false), [pathname]);

  return (
    <ErrorBoundary>
      <div className="flex h-screen overflow-hidden bg-bg text-fg">
        <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onMenu={() => setNavOpen(true)} />
          <main className="flex-1 overflow-y-auto px-4 py-5 sm:px-6 lg:px-8 lg:py-6">
            <Outlet />
          </main>
        </div>
      </div>
    </ErrorBoundary>
  );
}
