import { create } from 'zustand';

/**
 * App-wide modal arbitration. Every focus-trapping surface must claim one of
 * these owners before it renders, so two independent traps can never be live
 * at the same time. Authentication is intentionally non-preemptible by normal
 * UI: a keyboard shortcut must not hide a credential challenge.
 */
export type GlobalModalOwner =
  | 'authentication'
  | 'command-palette'
  | 'copilot'
  | 'database-row'
  | 'mobile-navigation';

const PRIORITY: Record<GlobalModalOwner, number> = {
  authentication: 100,
  'command-palette': 80,
  copilot: 60,
  'database-row': 40,
  'mobile-navigation': 20,
};

interface GlobalModalState {
  active: GlobalModalOwner | null;
  /** Returns false when a higher-priority modal currently owns the shell. */
  request: (owner: GlobalModalOwner) => boolean;
  /** Only the current owner may release the shell. */
  release: (owner: GlobalModalOwner) => void;
  reset: () => void;
}

export const useGlobalModalStore = create<GlobalModalState>((set, get) => ({
  active: null,
  request(owner) {
    const active = get().active;
    if (active === owner) return true;
    if (active && PRIORITY[active] > PRIORITY[owner]) return false;
    set({ active: owner });
    return true;
  },
  release(owner) {
    if (get().active === owner) set({ active: null });
  },
  reset() {
    set({ active: null });
  },
}));

export function mayRestoreModalFocus(owner: GlobalModalOwner): boolean {
  const active = useGlobalModalStore.getState().active;
  return active === null || active === owner;
}
