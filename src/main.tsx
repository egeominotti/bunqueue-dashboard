// Latin + latin-ext subsets only (see fonts.css) — the fontsource index
// imports pull cyrillic/greek/vietnamese woff2 the UI never renders.
import './fonts.css';
import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { initTheme } from './components/dashboard/stores/themeStore';
import { isDemo } from './lib/demo/isDemo';

initTheme();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

function render() {
  createRoot(rootEl as HTMLElement).render(
    <StrictMode>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <App />
      </BrowserRouter>
    </StrictMode>
  );
}

// The demo chunk IS the backend of a demo build, so a failed load can't be
// swallowed: rendering anyway would show demo chrome (badge, CTA, fixture-only
// Flows root) while every request escapes to a server that doesn't exist. Say so
// instead of shipping a demo that 404s in every panel.
function renderDemoLoadFailure(el: HTMLElement, err: unknown): void {
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText = 'padding:2rem;font:14px/1.6 system-ui,sans-serif;max-width:44rem;margin:auto';
  const h = document.createElement('h1');
  h.style.cssText = 'font-size:1.1rem;font-weight:600;margin-bottom:.5rem';
  h.textContent = 'Demo data failed to load';
  const p = document.createElement('p');
  p.textContent =
    'This build serves canned data from a bundled chunk that could not be fetched, ' +
    'so there is no backend to talk to. Reload the page (a hard refresh clears a ' +
    'stale cached index.html).';
  const detail = document.createElement('p');
  detail.style.cssText = 'margin-top:.75rem;opacity:.7;font-family:ui-monospace,monospace';
  detail.textContent = err instanceof Error ? err.message : String(err);
  box.append(h, p, detail);
  el.textContent = '';
  el.appendChild(box);
}

// In demo mode, install the fetch/SSE shim BEFORE the first render so no request
// escapes to a (non-existent) server. The install module and its fixture load
// lazily, so they never weigh on the normal bundle.
if (isDemo()) {
  import('./lib/demo/install')
    .then((m) => {
      m.installDemo();
      render();
    })
    .catch((err) => {
      console.error('[demo] failed to load the demo backend', err);
      renderDemoLoadFailure(rootEl as HTMLElement, err);
    });
} else {
  render();
}
