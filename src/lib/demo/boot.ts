export interface DemoBackendModule {
  installDemo: () => void;
}

export interface BootDashboardOptions {
  root: HTMLElement;
  demo: boolean;
  loadDemo: () => Promise<DemoBackendModule>;
  render: () => void;
  reportError?: (error: unknown) => void;
}

// The entry point must be safe if a loader/HMR integration evaluates it twice.
// A DOM root owns exactly one dashboard boot, including while its demo chunk is
// still in flight.
const boots = new WeakMap<HTMLElement, true | Promise<void>>();

/** Render a self-contained failure state when a demo build has no backend. */
export function renderDemoLoadFailure(el: HTMLElement, err: unknown): void {
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText = 'padding:2rem;font:14px/1.6 system-ui,sans-serif;max-width:44rem;margin:auto';

  const heading = document.createElement('h1');
  heading.style.cssText = 'font-size:1.1rem;font-weight:600;margin-bottom:.5rem';
  heading.textContent = 'Demo data failed to load';

  const explanation = document.createElement('p');
  explanation.textContent =
    'This build serves canned data from a bundled chunk that could not be fetched, ' +
    'so there is no backend to talk to. Reload the page (a hard refresh clears a ' +
    'stale cached index.html).';

  const detail = document.createElement('p');
  detail.style.cssText = 'margin-top:.75rem;opacity:.7;font-family:ui-monospace,monospace';
  detail.textContent = err instanceof Error ? err.message : String(err);

  box.append(heading, explanation, detail);
  el.replaceChildren(box);
}

/**
 * Install the demo transport before rendering. Keeping this orchestration free
 * of module-level side effects lets tests exercise both branches without
 * mounting a second application into the shared test DOM.
 */
export function bootDashboard({
  root,
  demo,
  loadDemo,
  render,
  reportError = (error) => console.error('[demo] failed to load the demo backend', error),
}: BootDashboardOptions): void | Promise<void> {
  const existing = boots.get(root);
  if (existing) return existing === true ? undefined : existing;

  if (!demo) {
    boots.set(root, true);
    try {
      render();
    } catch (error) {
      // No React root was successfully handed off, so an explicit retry is safe.
      boots.delete(root);
      throw error;
    }
    return;
  }

  // Start from a microtask so `boots` is populated before the loader can run;
  // re-entrant/concurrent calls therefore share this exact promise.
  const boot = Promise.resolve().then(async () => {
    let backend: DemoBackendModule;
    try {
      backend = await loadDemo();
      backend.installDemo();
    } catch (error) {
      try {
        reportError(error);
      } catch {
        // Reporting is best-effort; it must never suppress the visible fallback.
      }
      renderDemoLoadFailure(root, error);
      return;
    }

    // Rendering errors are application errors, not demo-chunk failures. Let
    // them reach the runtime/error boundary instead of mislabelling the page.
    render();
  });
  boots.set(root, boot);
  return boot;
}
