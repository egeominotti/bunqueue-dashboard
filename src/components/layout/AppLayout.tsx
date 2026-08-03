import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AlertEngine } from '@/components/AlertEngine';
import { AuthGate } from '@/components/AuthGate';
import { CommandPalette } from '@/components/CommandPalette';
import { Copilot } from '@/components/copilot/Copilot';
import {
  mayRestoreModalFocus,
  useGlobalModalStore,
} from '@/components/dashboard/stores/globalModalStore';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Toaster } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';
import { useRouteScrollReset } from '@/lib/useRouteScrollReset';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

export function AppLayout() {
  // Mobile nav drawer state. On lg+ the sidebar is always visible and this is
  // ignored; below lg it slides the sidebar in as an overlay.
  const [navOpen, setNavOpen] = useState(false);
  const { pathname, key: locationKey } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const navOpenerRef = useRef<HTMLButtonElement | null>(null);
  const activeModal = useGlobalModalStore((state) => state.active);
  const requestModal = useGlobalModalStore((state) => state.request);
  const releaseModal = useGlobalModalStore((state) => state.release);
  const navVisible = navOpen && activeModal === 'mobile-navigation';
  const closeNav = useCallback(() => {
    setNavOpen(false);
    releaseModal('mobile-navigation');
  }, [releaseModal]);

  // <main> owns the scroll (the document itself never scrolls). React Router
  // cannot restore a nested scroll container for us, so cached lazy routes used
  // to inherit the previous page's offset and open halfway down the content.
  useRouteScrollReset(mainRef, locationKey);

  // Close the drawer whenever the route changes (tapping a nav item navigates).
  // biome-ignore lint/correctness/useExhaustiveDependencies: close on navigation
  useEffect(() => closeNav(), [pathname, closeNav]);

  // Close the drawer if the viewport grows to lg (where the sidebar is a static
  // column). Without this, a resize/rotate while open would strand the two
  // navOpen-driven behaviors below — scroll-lock and the focus-trap — with no
  // lg-visible overlay to dismiss them.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = () => mq.matches && closeNav();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [closeNav]);

  // Escape closes the mobile drawer (standard dismissal affordance).
  useEffect(() => {
    if (!navVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeNav();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navVisible, closeNav]);

  // While the mobile drawer is open, keep focus inside it (WCAG 2.4.3 / 2.1.2):
  // move focus into the drawer on open, cycle Tab within it, and restore focus
  // to whatever opened it (the hamburger) on close.
  useEffect(() => {
    if (!navVisible) return;
    const nav = document.getElementById('app-nav');
    const focusables = () => {
      return nav
        ? Array.from(
            nav.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )
          )
        : [];
    };
    // The drawer transitions from visibility:hidden. Focusing in the same
    // commit can be ignored by the browser, leaving focus on <body>. A timeout
    // works even when requestAnimationFrame is paused in a background tab; the
    // second attempt covers browsers that keep visibility hidden until the
    // transition finishes.
    const focusFirst = () => focusables()[0]?.focus();
    const focusTimer = setTimeout(focusFirst, 0);
    const transitionFocusTimer = setTimeout(() => {
      if (!nav?.contains(document.activeElement)) focusFirst();
    }, 200);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      // Defensive recovery: if focus was moved outside programmatically (or
      // the initial transition focus was rejected), the next Tab returns to
      // the drawer instead of reaching the Copilot FAB or skip link.
      if (!nav?.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(focusTimer);
      clearTimeout(transitionFocusTimer);
      window.removeEventListener('keydown', onKey);
      const opener = navOpenerRef.current;
      if (mayRestoreModalFocus('mobile-navigation') && opener?.isConnected) opener.focus();
    };
  }, [navVisible]);

  // A higher-priority owner immediately hides the navigation surface. Drop its
  // local state as well so it cannot reappear when that owner closes.
  useEffect(() => {
    if (navOpen && activeModal !== 'mobile-navigation') setNavOpen(false);
  }, [navOpen, activeModal]);

  // A higher-priority authentication/command dialog must not coexist with the
  // navigation modal. Closing here also removes its inert background before
  // the other dialog moves focus into itself.
  useEffect(() => {
    const closeForDialog = () => closeNav();
    window.addEventListener('auth:gate-opened', closeForDialog);
    window.addEventListener('command-palette:open', closeForDialog);
    return () => {
      window.removeEventListener('auth:gate-opened', closeForDialog);
      window.removeEventListener('command-palette:open', closeForDialog);
    };
  }, [closeNav]);

  useEffect(
    () => () => {
      useGlobalModalStore.getState().release('mobile-navigation');
    },
    []
  );

  return (
    <ErrorBoundary>
      <div id="app-shell" className="flex h-screen overflow-hidden bg-bg text-fg">
        {/* First tab stop: lets keyboard/screen-reader users jump past the ~20
            nav links straight to the page content (WCAG 2.4.1 Bypass Blocks). */}
        <a
          href="#main"
          inert={activeModal !== null ? true : undefined}
          tabIndex={activeModal !== null ? -1 : undefined}
          className="sr-only rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg shadow-lg focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50"
        >
          Skip to content
        </a>
        <Sidebar
          open={navVisible}
          blocked={activeModal !== null && activeModal !== 'mobile-navigation'}
          onClose={closeNav}
        />
        <div
          id="app-content"
          className="flex min-w-0 flex-1 flex-col"
          inert={activeModal !== null ? true : undefined}
          aria-hidden={activeModal !== null || undefined}
        >
          <Topbar
            navOpen={navVisible}
            onMenu={(opener) => {
              if (requestModal('mobile-navigation')) {
                navOpenerRef.current = opener;
                setNavOpen(true);
              }
            }}
          />
          <main
            ref={mainRef}
            id="main"
            tabIndex={-1}
            className={cn(
              // pb-24 clears the fixed Copilot FAB (bottom-right) so it never
              // covers the last row / pagination controls on a scrolled page.
              'flex-1 px-4 pt-5 pb-24 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent sm:px-6 lg:px-8 lg:pt-6',
              // Lock content scroll while the drawer overlays it below lg.
              navVisible ? 'overflow-hidden' : 'overflow-y-auto'
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
        <div
          id="copilot-layer"
          inert={activeModal !== null && activeModal !== 'copilot' ? true : undefined}
          aria-hidden={(activeModal !== null && activeModal !== 'copilot') || undefined}
        >
          <Copilot />
        </div>
        <Toaster />
        <AlertEngine />
      </div>
    </ErrorBoundary>
  );
}
