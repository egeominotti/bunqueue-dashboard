import { Component, lazy, type ReactNode, Suspense } from 'react';
import { useCopilotStore } from '@/components/dashboard/stores/copilotStore';

/**
 * Copilot entry point. This module is intentionally light — it only pulls in the
 * zustand store — so it can live in the always-loaded shell. The actual panel
 * (which imports the Vercel AI SDK, ~160 KB gz) is lazy-loaded on first open, so
 * the SDK never touches the initial bundle.
 */
const CopilotPanel = lazy(() =>
  import('./CopilotPanel').then((m) => ({ default: m.CopilotPanel }))
);

function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z"
        fill="currentColor"
      />
      <path d="M19 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z" fill="currentColor" opacity="0.7" />
    </svg>
  );
}

/**
 * Keeps a Copilot failure inside the drawer. A rejected `import('./CopilotPanel')`
 * (stale hashed chunk after a redeploy, network blip) is re-thrown by Suspense and
 * would otherwise reach the shell ErrorBoundary in AppLayout — which has no
 * resetKey, so the only way out is a full reload, and a reload destroys every
 * deliberately memory-only secret (server/agent tokens, S3 keys, the Copilot key).
 */
export class CopilotBoundary extends Component<
  { onClose: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="fixed inset-y-0 right-0 z-[60] flex w-full max-w-md flex-col items-center justify-center gap-3 border-l border-line bg-surface px-6 text-center">
        <p className="text-sm text-fg">Copilot failed to load.</p>
        <p className="text-xs text-muted">
          The panel is loaded on demand; the request failed. If the dashboard was just redeployed,
          reload the page. The rest of the dashboard is unaffected.
        </p>
        <button
          type="button"
          onClick={() => {
            this.setState({ failed: false });
            this.props.onClose();
          }}
          className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
        >
          Close
        </button>
      </div>
    );
  }
}

export function Copilot() {
  const open = useCopilotStore((s) => s.open);
  const setOpen = useCopilotStore((s) => s.setOpen);

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-2.5 text-sm font-medium text-fg shadow-lg transition-colors hover:border-accent/50 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          aria-label="Open Copilot"
        >
          <SparkleIcon className="size-4 text-accent" />
          Copilot
          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
            beta
          </span>
        </button>
      )}
      {open && (
        <CopilotBoundary onClose={() => setOpen(false)}>
          <Suspense
            fallback={
              <div className="fixed inset-y-0 right-0 z-[60] flex w-full max-w-md items-center justify-center border-l border-line bg-surface text-sm text-muted">
                Loading Copilot…
              </div>
            }
          >
            <CopilotPanel />
          </Suspense>
        </CopilotBoundary>
      )}
    </>
  );
}
