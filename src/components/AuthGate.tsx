import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { bq } from '@/lib/bq';

type AuthScope = 'server' | 'agent';

/**
 * Token lock screen. When any `bq` API call gets a 401 (a bearer token is
 * missing or wrong), `bq.ts` dispatches a scoped `auth:required` window event
 * and this overlay prompts for the right token — the bunqueue server's token
 * for a server 401, the control agent's AGENT_TOKEN for an agent 401 (prompting
 * for the wrong one can never clear the lock). On submit it stores the token
 * (connection store, session-only, never persisted) and dismisses
 * optimistically; if still rejected, the next poll re-locks. Mounted once in
 * AppLayout.
 */
export function AuthGate() {
  const [locked, setLocked] = useState(false);
  const [scope, setScope] = useState<AuthScope>('server');
  const [value, setValue] = useState('');
  const baseUrl = useConnectionStore((s) => s.baseUrl);
  const setToken = useConnectionStore((s) => s.setToken);
  const setAgentToken = useConnectionStore((s) => s.setAgentToken);
  const inputRef = useRef<HTMLInputElement>(null);

  // Lock whenever the API reports a 401, remembering which backend rejected us.
  useEffect(() => {
    const onAuth = (e: Event) => {
      const s = (e as CustomEvent<{ scope?: AuthScope }>).detail?.scope;
      setScope(s === 'agent' ? 'agent' : 'server');
      setLocked(true);
    };
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
    if (scope === 'agent') setAgentToken(token);
    else setToken(token);
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
        {scope === 'agent' ? (
          <p className="mt-1 text-sm text-muted">
            The control agent at <span className="break-all font-mono text-fg">{bq.agentBase}</span>{' '}
            rejected the request (401). Enter its{' '}
            <span className="font-mono text-fg">AGENT_TOKEN</span> to continue.
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted">
            The server at <span className="break-all font-mono text-fg">{baseUrl}</span> rejected
            the request (401). Enter its bearer token to continue.
          </p>
        )}
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={scope === 'agent' ? 'AGENT_TOKEN' : 'Bearer token'}
          aria-label={scope === 'agent' ? 'Agent token' : 'Bearer token'}
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
