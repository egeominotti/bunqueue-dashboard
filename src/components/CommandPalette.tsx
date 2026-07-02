import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
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

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const toggleTheme = useThemeStore((s) => s.toggle);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

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
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('command-palette:open', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('command-palette:open', onOpen);
    };
  }, []);

  // Reset and focus the input each time it opens; restore focus to whatever
  // was focused (e.g. the Topbar trigger) when it closes.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    setQuery('');
    setActive(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(id);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  // Keep the highlighted row visible while arrowing.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({
      block: 'nearest',
    });
  }, [active]);

  const close = useCallback(() => setOpen(false), []);
  const exec = useCallback((c: Command | undefined) => {
    if (!c) return;
    c.run();
    setOpen(false);
  }, []);

  if (!open) return null;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      exec(filtered[active]);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      {/* Backdrop as a real button so "click outside to close" is keyboard- and
          screen-reader-accessible. */}
      <button
        type="button"
        aria-label="Close command palette"
        onClick={close}
        className="fixed inset-0 bg-black/50"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative z-10 w-full max-w-lg overflow-hidden rounded-xl border border-line-strong bg-surface shadow-2xl"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0); // reset the highlight to the top on each keystroke
          }}
          onKeyDown={onKeyDown}
          placeholder="Search pages and actions…"
          aria-label="Search pages and actions"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-fg outline-none placeholder:text-faint"
        />
        <ul ref={listRef} className="max-h-80 overflow-y-auto py-2" aria-label="Results">
          {filtered.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-faint">No matches</li>
          )}
          {filtered.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
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
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-faint">
          <span>↑↓ navigate · ↵ open · esc close</span>
          <span className="font-mono">⌘K</span>
        </div>
      </div>
    </div>
  );
}
