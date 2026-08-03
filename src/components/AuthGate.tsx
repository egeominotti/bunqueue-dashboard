import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getAgentAuthHeaders,
  getAuthHeaders,
  getBaseUrl,
  useConnectionStore,
} from '@/components/dashboard/stores/connectionStore';
import {
  mayRestoreModalFocus,
  useGlobalModalStore,
} from '@/components/dashboard/stores/globalModalStore';
import { bq } from '@/lib/bq';

type AuthScope = 'server' | 'agent';
type AuthRequiredDetail = { scope?: AuthScope; auth?: string; target?: string };
interface AuthIdentity {
  scope: AuthScope;
  auth?: string;
  target: string;
}

function currentAuthIdentity(scope: AuthScope): AuthIdentity {
  return {
    scope,
    auth: scope === 'agent' ? getAgentAuthHeaders().Authorization : getAuthHeaders().Authorization,
    target: scope === 'agent' ? bq.agentBase : getBaseUrl(),
  };
}

function sameAuthIdentity(a: AuthIdentity | null, b: AuthIdentity): boolean {
  return a?.scope === b.scope && a.auth === b.auth && a.target === b.target;
}

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
  const dialogRef = useRef<HTMLFormElement>(null);
  const acceptedIdentity = useRef<AuthIdentity | null>(null);
  const draft = useRef<{ identity: AuthIdentity; value: string } | null>(null);
  const activeModal = useGlobalModalStore((state) => state.active);
  const visible = locked && activeModal === 'authentication';

  // Lock whenever the API reports a 401, remembering which backend rejected us.
  // The request carries the exact Authorization value and backend it used.
  // Compare both with the CURRENT connection so a slow 401 from an old token or
  // old backend cannot relock the gate after the operator has moved on.
  useEffect(() => {
    const onAuth = (e: Event) => {
      const detail = (e as CustomEvent<AuthRequiredDetail>).detail;
      if (detail?.scope !== 'server' && detail?.scope !== 'agent') return;
      const nextIdentity = currentAuthIdentity(detail.scope);
      // Fail closed for legacy/malformed events: accepting a missing target
      // would let a late 401 from another server gate the active connection.
      if (detail.auth !== nextIdentity.auth || detail.target !== nextIdentity.target) return;
      if (!sameAuthIdentity(acceptedIdentity.current, nextIdentity)) {
        // A token draft belongs to one exact backend/request identity. Never
        // carry a server secret into an agent prompt (or server A into B).
        draft.current = null;
        setValue('');
      }
      acceptedIdentity.current = nextIdentity;
      // Authentication has the highest modal priority and synchronously
      // replaces any palette/drawer before this gate is rendered.
      useGlobalModalStore.getState().request('authentication');
      setScope(nextIdentity.scope);
      setLocked(true);
      window.dispatchEvent(new window.Event('auth:gate-opened'));
    };
    window.addEventListener('auth:required', onAuth);
    return () => window.removeEventListener('auth:required', onAuth);
  }, []);

  useEffect(
    () => () => {
      useGlobalModalStore.getState().release('authentication');
    },
    []
  );

  // Modal focus contract: hide/inert the app beneath it, move focus inside,
  // cycle Tab, and restore the opener when authentication succeeds.
  useEffect(() => {
    if (!visible) return;
    const opener = document.activeElement as HTMLElement | null;
    const background = document.getElementById('app-shell')
      ? []
      : ['app-nav', 'app-content']
          .map((id) => document.getElementById(id))
          .filter((element): element is HTMLElement => element !== null);
    const previous = background.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }));
    for (const element of background) {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    }
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    const focusables = () =>
      dialogRef.current
        ? Array.from(
            dialogRef.current.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )
          )
        : [];
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.cancelAnimationFrame(id);
      window.removeEventListener('keydown', onKey);
      for (const state of previous) {
        state.element.inert = state.inert;
        if (state.ariaHidden === null) state.element.removeAttribute('aria-hidden');
        else state.element.setAttribute('aria-hidden', state.ariaHidden);
      }
      if (mayRestoreModalFocus('authentication') && opener?.isConnected) opener.focus();
    };
  }, [visible]);

  const dismiss = () => {
    acceptedIdentity.current = null;
    draft.current = null;
    setValue('');
    setLocked(false);
    useGlobalModalStore.getState().release('authentication');
  };

  if (!visible) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const identity = acceptedIdentity.current;
    const currentDraft = draft.current;
    if (
      !identity ||
      !currentDraft ||
      !sameAuthIdentity(currentDraft.identity, identity) ||
      !sameAuthIdentity(identity, currentAuthIdentity(identity.scope))
    ) {
      // The connection changed while the gate was open, or this render still
      // contains a draft from a superseded prompt. Close without assigning it.
      dismiss();
      return;
    }
    const token = currentDraft.value.trim();
    if (!token) return;
    if (identity.scope === 'agent') setAgentToken(token);
    else setToken(token);
    dismiss(); // optimistic; a still-401 poll re-locks
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <form
        ref={dialogRef}
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
          onInput={(e) => {
            const nextValue = e.currentTarget.value;
            setValue(nextValue);
            const identity = acceptedIdentity.current;
            draft.current = identity ? { identity, value: nextValue } : null;
          }}
          placeholder={scope === 'agent' ? 'AGENT_TOKEN' : 'Bearer token'}
          aria-label={scope === 'agent' ? 'Agent token' : 'Bearer token'}
          name={scope === 'agent' ? 'agent-token' : 'server-token'}
          autoComplete="current-password"
          className="mt-4 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-accent/50"
        />
        <div className="mt-4 flex items-center justify-between gap-3">
          <Link
            to="/settings"
            onClick={dismiss}
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
