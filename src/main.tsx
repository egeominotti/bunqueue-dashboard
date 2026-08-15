// Latin + latin-ext subsets only (see fonts.css) — the fontsource index
// imports pull cyrillic/greek/vietnamese woff2 the UI never renders.
import './fonts.css';
import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { initTheme } from './components/dashboard/stores/themeStore';
import { bootDashboard } from './lib/demo/boot';
import { isDemo } from './lib/demo/isDemo';
import { resolveRouterBasename, runtimeConfigValue } from './lib/runtimeConfig';

initTheme();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

function render() {
  createRoot(rootEl as HTMLElement).render(
    <StrictMode>
      <BrowserRouter
        basename={resolveRouterBasename(
          runtimeConfigValue('__BUNQUEUE_BASE_PATH__'),
          import.meta.env.BASE_URL
        )}
      >
        <App />
      </BrowserRouter>
    </StrictMode>
  );
}

// In demo mode, install the fetch/SSE shim BEFORE the first render so no request
// escapes to a (non-existent) server. The install module and its fixture load
// lazily, so they never weigh on the normal bundle.
void bootDashboard({
  root: rootEl,
  demo: isDemo(),
  loadDemo: () => import('./lib/demo/install'),
  render,
});
