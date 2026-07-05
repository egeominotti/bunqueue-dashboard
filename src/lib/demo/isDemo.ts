/**
 * Demo mode serves canned data from a bundled fixture instead of talking to a
 * real bunqueue server, so the dashboard is fully explorable with no backend
 * (this is what the hosted GitHub Pages build runs). It is enabled by the
 * `VITE_DEMO=1` build flag (the deployed demo) or, for a local preview, a
 * `?demo` query param or `#demo` hash.
 *
 * Kept tiny and dependency-free so `main.tsx` can check it up front and only
 * then lazily import the heavier install module (and its fixture chunk), which
 * keeps demo code and data out of the normal app bundle.
 */
// Memoized: demo mode is fixed for the page's lifetime (the fetch/SSE shim is
// installed once at boot). Evaluating live per call let post-navigation callers
// disagree — React Router drops the `?demo`/`#demo` from the URL on the first
// nav, so a render-time isDemo() flipped to false while the shim kept serving
// canned data (SidebarFooter CTA vanished, Flows lost its default DAG), while
// the boot-time consumers (main.tsx, Topbar) still read true. Cache so all agree.
let cached: boolean | undefined;

export function isDemo(): boolean {
  if (cached !== undefined) return cached;
  cached = computeIsDemo();
  return cached;
}

function computeIsDemo(): boolean {
  if (import.meta.env.VITE_DEMO === '1') return true;
  if (typeof window === 'undefined') return false;
  const { search, hash } = window.location;
  return new URLSearchParams(search).has('demo') || hash.replace(/^#/, '') === 'demo';
}
