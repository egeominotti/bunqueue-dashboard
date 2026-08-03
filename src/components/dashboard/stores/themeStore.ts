import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

export type Theme = 'dark' | 'light';

interface ThemeState {
  theme: Theme;
  toggle: () => void;
  setTheme: (theme: Theme) => void;
}

const THEME_STORAGE_KEY = 'bq-dash-theme';
const THEME_STORAGE_VERSION = 1;

function safeTheme(value: unknown): Theme {
  return value === 'light' ? 'light' : 'dark';
}

function localThemeStorage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Theme durability is optional: blocked/full storage must never break Settings. */
const resilientThemeStorage: StateStorage = {
  getItem(name) {
    const storage = localThemeStorage();
    if (!storage) return null;
    try {
      const raw = storage.getItem(name);
      if (raw === null || name !== THEME_STORAGE_KEY) return raw;
      const parsed = JSON.parse(raw) as unknown;
      const envelope =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as { state?: unknown })
          : {};
      const persisted =
        envelope.state && typeof envelope.state === 'object' && !Array.isArray(envelope.state)
          ? (envelope.state as { theme?: unknown })
          : {};
      const canonical = JSON.stringify({
        state: { theme: safeTheme(persisted.theme) },
        version: THEME_STORAGE_VERSION,
      });
      if (raw !== canonical) {
        try {
          storage.setItem(name, canonical);
        } catch {
          // Hydration can still use the sanitized in-memory value.
        }
      }
      return canonical;
    } catch {
      try {
        storage.removeItem(name);
      } catch {
        // Storage is optional; fall back to the default theme.
      }
      return null;
    }
  },
  setItem(name, value) {
    try {
      localThemeStorage()?.setItem(name, value);
    } catch {
      // Keep the already-applied in-memory theme for this session.
    }
  },
  removeItem(name) {
    try {
      localThemeStorage()?.removeItem(name);
    } catch {
      // Nothing else depends on durable theme cleanup.
    }
  },
};

function applyTheme(theme: Theme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      toggle: () => {
        const next: Theme = get().theme === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        set({ theme: next });
      },
      setTheme: (theme) => {
        const next = safeTheme(theme);
        applyTheme(next);
        set({ theme: next });
      },
    }),
    {
      name: THEME_STORAGE_KEY,
      version: THEME_STORAGE_VERSION,
      storage: createJSONStorage(() => resilientThemeStorage),
      partialize: (state) => ({ theme: safeTheme(state.theme) }),
      merge: (persisted, current) => {
        const raw =
          persisted && typeof persisted === 'object' && !Array.isArray(persisted)
            ? (persisted as { theme?: unknown })
            : {};
        return { ...current, theme: safeTheme(raw.theme) };
      },
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(safeTheme(state.theme));
      },
    }
  )
);

/** Apply the persisted theme on first load (called from main.tsx before render). */
export function initTheme(): void {
  applyTheme(safeTheme(useThemeStore.getState().theme));
}
