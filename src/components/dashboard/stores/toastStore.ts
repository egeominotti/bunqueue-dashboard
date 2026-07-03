import { create } from 'zustand';

/**
 * App-wide transient action feedback. Complements — does not replace — the inline
 * per-page `{ok,text}` messages: a toast survives navigation, so a fire-and-leave
 * action (bulk requeue, a slow server restart) is still confirmed after the
 * operator moves to another page. Rendered once by <Toaster/> in AppLayout.
 */
export type ToastLevel = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  level: ToastLevel;
  title: string;
  detail?: string;
  ttlMs: number;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id' | 'ttlMs'> & { ttlMs?: number }) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;
// Cap the visible stack so an alert burst / large fan-out can't pile up
// off-screen; the oldest are dropped (they auto-dismiss anyway).
const MAX_TOASTS = 5;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: ({ level, title, detail, ttlMs }) => {
    const id = nextId++;
    // Errors linger longer than successes — a failure is worth reading.
    const ttl = ttlMs ?? (level === 'error' ? 8000 : 4000);
    set((s) => ({
      toasts: [...s.toasts, { id, level, title, detail, ttlMs: ttl }].slice(-MAX_TOASTS),
    }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/**
 * Imperative helper for non-React call sites (event handlers, catch blocks). Keeps
 * `detail` short — a long stack trace belongs in the Job Inspector, not a toast.
 */
export const toast = {
  success: (title: string, detail?: string) =>
    useToastStore.getState().push({ level: 'success', title, detail }),
  error: (title: string, detail?: string) =>
    useToastStore.getState().push({ level: 'error', title, detail }),
  info: (title: string, detail?: string) =>
    useToastStore.getState().push({ level: 'info', title, detail }),
};
