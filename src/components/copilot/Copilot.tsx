import { lazy, Suspense } from 'react';
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
        <Suspense
          fallback={
            <div className="fixed inset-y-0 right-0 z-[60] flex w-full max-w-md items-center justify-center border-l border-line bg-surface text-sm text-muted">
              Loading Copilot…
            </div>
          }
        >
          <CopilotPanel />
        </Suspense>
      )}
    </>
  );
}
