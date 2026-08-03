import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  mayRestoreModalFocus,
  useGlobalModalStore,
} from '@/components/dashboard/stores/globalModalStore';
import { useThemeStore } from '@/components/dashboard/stores/themeStore';
import { NAV } from '@/components/layout/Sidebar';

/**
 * Global command palette (Cmd/Ctrl-K). Fuzzy-searches every navigation
 * destination (sourced from the sidebar NAV, so it stays in sync) plus a few
 * actions, and jumps there. Fully keyboard-driven: ↑/↓ to move, ↵ to run, esc
 * to close. Mounted once in AppLayout. Opens on the hotkey or a
 * `command-palette:open` window event (dispatched by the Topbar trigger).
 */

type Command = { id: string; label: string; hint: string; run: () => void };

const DOCS_URL = 'https://egeominotti.github.io/bunqueue-dashboard/docs/';
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isolateSiblings(modalRoot: HTMLElement): () => void {
  const parent = modalRoot.parentElement;
  if (!parent) return () => {};
  const siblings = Array.from(parent.children).filter(
    (node) => node !== modalRoot
  ) as HTMLElement[];
  const previous = siblings.map((node) => ({
    node,
    inert: node.inert,
    ariaHidden: node.getAttribute('aria-hidden'),
  }));
  for (const node of siblings) {
    node.inert = true;
    node.setAttribute('aria-hidden', 'true');
  }
  return () => {
    for (const { node, inert, ariaHidden } of previous) {
      node.inert = inert;
      if (ariaHidden == null) node.removeAttribute('aria-hidden');
      else node.setAttribute('aria-hidden', ariaHidden);
    }
  };
}

export function CommandPalette() {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const open = useGlobalModalStore((state) => state.active === 'command-palette');
  const releaseModal = useGlobalModalStore((state) => state.release);
  const navigate = useNavigate();
  const toggleTheme = useThemeStore((s) => s.toggle);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => releaseModal('command-palette'), [releaseModal]);

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = NAV.flatMap((group) =>
      group.items.map((item) => ({
        id: `nav:${item.to}`,
        label: item.label,
        hint: group.section ?? 'Home',
        run: () => navigate(item.to),
      }))
    );
    const actions: Command[] = [
      { id: 'act:theme', label: 'Toggle theme (dark / light)', hint: 'Action', run: toggleTheme },
      {
        id: 'act:docs',
        label: 'Open documentation',
        hint: 'Action',
        run: () => window.open(DOCS_URL, '_blank', 'noopener'),
      },
    ];
    return [...nav, ...actions];
  }, [navigate, toggleTheme]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => `${c.label} ${c.hint}`.toLowerCase().includes(q));
  }, [commands, query]);

  // Open on Cmd/Ctrl-K or a window event; the hotkey also toggles it closed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const modal = useGlobalModalStore.getState();
        if (modal.active === 'command-palette') modal.release('command-palette');
        else modal.request('command-palette');
      }
    };
    const onOpen = () => useGlobalModalStore.getState().request('command-palette');
    window.addEventListener('keydown', onKey);
    window.addEventListener('command-palette:open', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('command-palette:open', onOpen);
    };
  }, []);

  // Reset and focus the input each time it opens. While modal, keep keyboard
  // focus inside, make the app behind it inert to pointer/AT navigation, and
  // restore both the previous DOM state and opener focus on close.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    setQuery('');
    setActive(0);
    // AppLayout owns declarative shell isolation. Keep the local fallback for
    // standalone embeds/tests where no shell exists.
    const restoreIsolation =
      rootRef.current && !document.getElementById('app-shell')
        ? isolateSiblings(rootRef.current)
        : () => {};
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    const onModalKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeElement = document.activeElement;
      if (e.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onModalKey);
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener('keydown', onModalKey);
      restoreIsolation();
      if (mayRestoreModalFocus('command-palette') && previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [open, close]);

  // Keep the highlighted row visible while arrowing.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({
      block: 'nearest',
    });
  }, [active]);

  const exec = useCallback(
    (c: Command | undefined) => {
      if (!c) return;
      c.run();
      close();
    },
    [close]
  );

  if (!open) return null;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      exec(filtered[active]);
    }
  };

  return (
    <div ref={rootRef} className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      {/* Backdrop as a real button so "click outside to close" is keyboard- and
          screen-reader-accessible. */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close command palette"
        onClick={close}
        className="fixed inset-0 bg-black/50"
      />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative z-10 w-full max-w-lg overflow-hidden rounded-xl border border-line-strong bg-surface shadow-2xl"
      >
        <input
          ref={inputRef}
          role="combobox"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0); // reset the highlight to the top on each keystroke
          }}
          onKeyDown={onKeyDown}
          placeholder="Search pages and actions…"
          aria-label="Search pages and actions"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="command-palette-results"
          aria-activedescendant={filtered[active] ? `command-palette-option-${active}` : undefined}
          autoComplete="off"
          name="command-palette-search"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
        />
        <div
          ref={listRef}
          id="command-palette-results"
          role="listbox"
          className="max-h-80 overflow-y-auto overscroll-contain py-2"
          aria-label="Results"
        >
          {filtered.length === 0 && (
            <div role="presentation" className="px-4 py-6 text-center text-sm text-faint">
              No matches
            </div>
          )}
          {filtered.map((c, i) => (
            <div key={c.id} role="presentation">
              <button
                type="button"
                id={`command-palette-option-${i}`}
                role="option"
                aria-selected={i === active}
                tabIndex={-1}
                data-idx={i}
                onMouseEnter={() => setActive(i)}
                onClick={() => exec(c)}
                className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm transition-colors ${
                  i === active ? 'bg-accent/15 text-fg' : 'text-muted'
                }`}
              >
                <span className="truncate">{c.label}</span>
                <span className="shrink-0 text-xs text-faint">{c.hint}</span>
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-faint">
          <span>↑↓ navigate · ↵ open · esc close</span>
          <span className="font-mono">⌘K</span>
        </div>
      </div>
    </div>
  );
}
