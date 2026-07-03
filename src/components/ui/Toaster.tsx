import { useEffect } from 'react';
import { type Toast, useToastStore } from '@/components/dashboard/stores/toastStore';
import { cn } from '@/lib/cn';
import { IconClose } from './icons';

const LEVEL_STYLES: Record<Toast['level'], { bar: string; title: string }> = {
  success: { bar: 'bg-emerald-500', title: 'text-success' },
  error: { bar: 'bg-red-500', title: 'text-danger' },
  info: { bar: 'bg-accent', title: 'text-accent' },
};

function ToastCard({ toast, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  // Depend on the stable store `dismiss` + this toast's id/ttl — NOT a freshly
  // built closure — so an unrelated toast being added/removed doesn't reset this
  // one's auto-dismiss timer.
  useEffect(() => {
    const t = window.setTimeout(() => dismiss(toast.id), toast.ttlMs);
    return () => window.clearTimeout(t);
  }, [toast.id, toast.ttlMs, dismiss]);

  const style = LEVEL_STYLES[toast.level];
  return (
    <div className="pointer-events-auto flex w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
      <span className={cn('w-1 shrink-0', style.bar)} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 items-start gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className={cn('text-sm font-medium', style.title)}>{toast.title}</div>
          {toast.detail && (
            <div className="mt-0.5 break-words text-xs text-muted">{toast.detail}</div>
          )}
        </div>
        <button
          type="button"
          onClick={() => dismiss(toast.id)}
          aria-label="Dismiss notification"
          className="-mr-1 shrink-0 rounded p-0.5 text-faint hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <IconClose className="size-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * Fixed bottom-right toast stack. Mounted once in AppLayout; reads the toast
 * store so any page (or non-React helper) can raise durable feedback.
 */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <section
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2"
      aria-label="Notifications"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} dismiss={dismiss} />
      ))}
    </section>
  );
}
