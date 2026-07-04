import { Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AlertEngine } from '@/components/AlertEngine';
import { AuthGate } from '@/components/AuthGate';
import { CommandPalette } from '@/components/CommandPalette';
import { Copilot } from '@/components/copilot/Copilot';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Toaster } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

export function AppLayout() {
  // Mobile nav drawer state. On lg+ the sidebar is always visible and this is
  // ignored; below lg it slides the sidebar in as an overlay.
  const [navOpen, setNavOpen] = useState(false);
  const { pathname, key: locationKey } = useLocation();

  // Close the drawer whenever the route changes (tapping a nav item navigates).
  // biome-ignore lint/correctness/useExhaustiveDependencies: close on navigation
  useEffect(() => setNavOpen(false), [pathname]);

  // Close the drawer if the viewport grows to lg (where the sidebar is a static
  // column). Without this, a resize/rotate while open would strand the two
  // navOpen-driven behaviors below — scroll-lock and the focus-trap — with no
  // lg-visible overlay to dismiss them.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = () => mq.matches && setNavOpen(false);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Escape closes the mobile drawer (standard dismissal affordance).
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  // While the mobile drawer is open, keep focus inside it (WCAG 2.4.3 / 2.1.2):
  // move focus into the drawer on open, cycle Tab within it, and restore focus
  // to whatever opened it (the hamburger) on close.
  useEffect(() => {
    if (!navOpen) return;
    const opener = document.activeElement as HTMLElement | null;
    const focusables = () => {
      const nav = document.getElementById('app-nav');
      return nav
        ? Array.from(
            nav.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )
          )
        : [];
    };
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [navOpen]);

  return (
    <ErrorBoundary>
      <div className="flex h-screen overflow-hidden bg-bg text-fg">
        {/* First tab stop: lets keyboard/screen-reader users jump past the ~20
            nav links straight to the page content (WCAG 2.4.1 Bypass Blocks). */}
        <a
          href="#main"
          className="sr-only rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg shadow-lg focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50"
        >
          Skip to content
        </a>
        <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar navOpen={navOpen} onMenu={() => setNavOpen(true)} />
          <main
            id="main"
            tabIndex={-1}
            className={cn(
              // pb-24 clears the fixed Copilot FAB (bottom-right) so it never
              // covers the last row / pagination controls on a scrolled page.
              'flex-1 px-4 pt-5 pb-24 outline-none sm:px-6 lg:px-8 lg:pt-6',
              // Lock content scroll while the drawer overlays it below lg.
              navOpen ? 'overflow-hidden' : 'overflow-y-auto'
            )}
          >
            <Suspense fallback={<div className="p-2 text-sm text-muted">Loading…</div>}>
              {/* Page-scoped boundary: a crashing page keeps the shell alive and
                  the error clears on ANY navigation (resetKey = location.key —
                  pathname alone would miss re-clicking the same nav item and
                  search-param-only routes like /job?id=X). */}
              <ErrorBoundary resetKey={locationKey}>
                <Outlet />
              </ErrorBoundary>
            </Suspense>
          </main>
        </div>
        <CommandPalette />
        <AuthGate />
        <Copilot />
        <Toaster />
        <AlertEngine />
      </div>
    </ErrorBoundary>
  );
}
