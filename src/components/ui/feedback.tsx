import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent',
        className
      )}
      role="status"
      aria-label="Loading"
    />
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-sm text-muted">
      <Spinner />
      {label}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line py-14 text-center">
      {icon && <div className="text-faint [&>svg]:size-8">{icon}</div>}
      <div className="text-sm font-medium text-fg">{title}</div>
      {hint && <div className="max-w-sm text-xs text-faint">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * Subtle, non-blocking "not connected" notice. Shown at the top of a page when
 * the bunqueue server is unreachable (or running embedded with no HTTP surface)
 * so the page still renders its layout with empty data instead of a blocking
 * error screen. Not red, not full-page — just an amber hint that data is stale.
 */
export function OfflineBanner({
  onRetry,
  message = 'Not connected to the bunqueue server — showing empty data.',
}: {
  onRetry?: () => void;
  /** Override when the unreachable thing isn't the bunqueue server (e.g. the control agent). */
  message?: string;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-4 py-2.5 text-sm">
      <span className="size-2 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
      <span className="text-amber-300/90 light:text-amber-700">{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="ml-auto shrink-0 rounded-md border border-amber-500/30 px-2.5 py-1 text-xs font-medium text-amber-200 light:text-amber-700 hover:border-amber-400/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-red-500/20 bg-red-500/5 py-14 text-center">
      <div className="text-sm font-medium text-danger">Something went wrong</div>
      <div className="max-w-md text-xs text-faint">{error.message}</div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg hover:border-line-strong"
        >
          Retry
        </button>
      )}
    </div>
  );
}
