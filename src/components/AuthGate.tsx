import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';

/**
 * Token lock screen. When any `bq` API call gets a 401 (the bunqueue server runs
 * with AUTH_TOKENS and our bearer token is missing or wrong), `bq.ts` dispatches
 * an `auth:required` window event and this overlay prompts for the token. On
 * submit it stores the token (connection store, session-only, never persisted)
 * and dismisses optimistically; if the token is still rejected, the next poll
 * re-locks. Mounted once in AppLayout.
 */
export function AuthGate() {
  const [locked, setLocked] = useState(false);
  const [value, setValue] = useState('');
  const baseUrl = useConnectionStore((s) => s.baseUrl);
  const setToken = useConnectionStore((s) => s.setToken);
  const inputRef = useRef<HTMLInputElement>(null);

  // Lock whenever the API reports a 401.
  useEffect(() => {
    const onAuth = () => setLocked(true);
    window.addEventListener('auth:required', onAuth);
    return () => window.removeEventListener('auth:required', onAuth);
  }, []);

  // Focus the token field when the gate appears.
  useEffect(() => {
    if (!locked) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [locked]);

  if (!locked) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;
    setToken(token);
    setValue('');
    setLocked(false); // optimistic; a still-401 poll re-locks
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label="Authentication required"
        className="w-full max-w-sm rounded-xl border border-line-strong bg-surface p-6 shadow-2xl"
      >
        <h2 className="text-lg font-semibold text-fg">Authentication required</h2>
        <p className="mt-1 text-sm text-muted">
          The server at <span className="break-all font-mono text-fg">{baseUrl}</span> rejected the
          request (401). Enter its bearer token to continue.
        </p>
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Bearer token"
          aria-label="Bearer token"
          autoComplete="off"
          className="mt-4 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-accent/50"
        />
        <div className="mt-4 flex items-center justify-between gap-3">
          <Link
            to="/settings"
            onClick={() => setLocked(false)}
            className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline"
          >
            Open Settings instead
          </Link>
          <button
            type="submit"
            disabled={!value.trim()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50"
          >
            Unlock
          </button>
        </div>
      </form>
    </div>
  );
}
