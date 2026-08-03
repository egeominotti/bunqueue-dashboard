import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

/**
 * Copilot chat state. The API key lives in memory only (never persisted — an
 * LLM key in plaintext-at-rest is readable by any same-origin XSS); the provider
 * choice, custom-provider base URL, and model id ARE persisted so the panel
 * remembers the setup. Named providers always discard baseURL because their
 * fixed destination is the boundary that protects the model API key.
 * Mutating tools pause on a confirmation gate: the tool's execute() awaits a
 * Promise held in `resolvers`, and the UI resolves it when the user clicks
 * Confirm/Decline.
 */
export interface ToolEvent {
  id: string;
  name: string;
  label: string;
  mutates: boolean;
  status: 'awaiting' | 'running' | 'done' | 'error' | 'declined';
  args?: unknown;
  result?: unknown;
  error?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tools?: ToolEvent[];
  error?: boolean;
  /** Set once the turn settles (completed, errored, or aborted) — distinguishes
   *  a still-streaming empty assistant ("Thinking…") from one that ended empty. */
  done?: boolean;
}

export interface PendingConfirm {
  id: string;
  name: string;
  label: string;
  args: unknown;
}

export interface CopilotConfig {
  provider: string;
  baseURL: string;
  model: string;
  apiKey: string;
}

export const COPILOT_STORAGE_KEY = 'bq-dash-copilot';
const COPILOT_STORAGE_VERSION = 1;
// Keep in sync with lib/copilot/providers.ts. Persisted provider ids are a
// trust boundary because the selected provider determines where an API key and
// chat payload may be sent.
const COPILOT_PROVIDER_IDS = new Set([
  'anthropic',
  'openai',
  'google',
  'zai',
  'openrouter',
  'custom',
]);
const DEFAULT_COPILOT_CONFIG: CopilotConfig = {
  provider: 'anthropic',
  baseURL: '',
  model: 'claude-opus-4-8',
  apiKey: '',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function safeProvider(value: unknown): string {
  return typeof value === 'string' && COPILOT_PROVIDER_IDS.has(value)
    ? value
    : DEFAULT_COPILOT_CONFIG.provider;
}

function sanitizedConfig(value: unknown, apiKey = ''): CopilotConfig {
  const stored = isRecord(value) ? value : {};
  const provider = safeProvider(stored.provider);
  return {
    provider,
    baseURL:
      provider === 'custom'
        ? safeString(stored.baseURL, DEFAULT_COPILOT_CONFIG.baseURL)
        : DEFAULT_COPILOT_CONFIG.baseURL,
    model: safeString(stored.model, DEFAULT_COPILOT_CONFIG.model),
    apiKey,
  };
}

/** Sanitize the persisted projection and always discard historical API keys. */
export function sanitizedPersistedCopilotState(value: unknown): {
  config: Omit<CopilotConfig, 'apiKey'>;
} {
  const stored = isRecord(value) ? value : {};
  const config = sanitizedConfig(stored.config);
  return {
    config: { provider: config.provider, baseURL: config.baseURL, model: config.model },
  };
}

// Ids must be unique even without crypto.randomUUID — that API is gated on a
// SECURE context, so on a plain-http LAN/Docker origin the fallback is the only
// branch that ever runs. A bare `${Date.now()}` collides for anything minted in
// the same millisecond (two tool calls in one model step), which would make one
// confirm card resolve another's promise; the counter + random suffix can't.
let uidSeq = 0;
const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${(uidSeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Confirmation resolvers kept OUT of store state so they are never serialized.
const resolvers = new Map<string, (approved: boolean) => void>();

interface CopilotState {
  open: boolean;
  config: CopilotConfig;
  messages: ChatMessage[];
  pending: PendingConfirm[];
  busy: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
  setConfig: (patch: Partial<CopilotConfig>) => void;
  clear: () => void;
  cancelPending: () => void;
  setBusy: (v: boolean) => void;
  addUser: (content: string) => void;
  startAssistant: () => string;
  appendAssistant: (id: string, delta: string) => void;
  finishAssistant: (id: string, opts?: { error?: string }) => void;
  addTool: (msgId: string, ev: ToolEvent) => void;
  updateTool: (msgId: string, evId: string, patch: Partial<ToolEvent>) => void;
  requestConfirm: (c: Omit<PendingConfirm, 'id'>) => Promise<boolean>;
  resolveConfirm: (id: string, approved: boolean) => void;
}

const patchMessage = (messages: ChatMessage[], id: string, fn: (m: ChatMessage) => ChatMessage) =>
  messages.map((m) => (m.id === id ? fn(m) : m));

/**
 * The subset written to localStorage. The API key is deliberately EXCLUDED — an
 * LLM key in plaintext-at-rest is readable by any same-origin XSS or extension
 * and never expires. Only the non-secret setup (provider/custom baseURL/model)
 * is kept. Fixed providers persist an empty baseURL so a stale hidden field can
 * never become a credential-exfiltration destination.
 */
export function persistedCopilotState(s: Pick<CopilotState, 'config'>) {
  return sanitizedPersistedCopilotState(s);
}

function browserStorage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function sanitizeStoredEnvelope(raw: string): { hydration: string; canonical: string } | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const envelope = isRecord(parsed) ? parsed : {};
    const rawState = 'state' in envelope ? envelope.state : envelope;
    const state = sanitizedPersistedCopilotState(rawState);
    const version = typeof envelope.version === 'number' ? envelope.version : undefined;
    return {
      hydration: JSON.stringify({ state, ...(version === undefined ? {} : { version }) }),
      canonical: JSON.stringify({ state, version: COPILOT_STORAGE_VERSION }),
    };
  } catch {
    return null;
  }
}

const resilientCopilotStorage: StateStorage = {
  getItem(name) {
    const storage = browserStorage();
    if (!storage) return null;
    let raw: string | null;
    try {
      raw = storage.getItem(name);
    } catch {
      return null;
    }
    if (raw === null || name !== COPILOT_STORAGE_KEY) return raw;
    const sanitized = sanitizeStoredEnvelope(raw);
    if (!sanitized) {
      try {
        storage.removeItem(name);
      } catch {
        // Corrupt optional storage falls back to the default provider config.
      }
      return null;
    }
    if (raw !== sanitized.canonical) {
      try {
        storage.setItem(name, sanitized.canonical);
      } catch {
        // If rewrite is blocked, deleting the legacy API-key blob is safer than
        // leaving it at rest. The sanitized in-memory setup still hydrates.
        try {
          storage.removeItem(name);
        } catch {
          // Storage is externally controlled; no exception may escape hydration.
        }
      }
    }
    return sanitized.hydration;
  },
  setItem(name, value) {
    try {
      browserStorage()?.setItem(name, value);
    } catch {
      // The session config remains usable if storage is blocked/full.
    }
  },
  removeItem(name) {
    try {
      browserStorage()?.removeItem(name);
    } catch {
      // Durable cleanup is best-effort.
    }
  },
};

export const useCopilotStore = create<CopilotState>()(
  persist(
    (set) => ({
      open: false,
      config: { ...DEFAULT_COPILOT_CONFIG },
      messages: [],
      pending: [],
      busy: false,

      setOpen: (v) => set({ open: v }),
      toggle: () => set((s) => ({ open: !s.open })),
      setConfig: (patch) =>
        set((s) => {
          const next = { ...s.config, ...patch };
          return { config: sanitizedConfig(next, safeString(next.apiKey, '')) };
        }),
      clear: () => {
        for (const resolve of resolvers.values()) resolve(false);
        resolvers.clear();
        set({ messages: [], pending: [] });
      },
      // Resolve every awaiting confirmation as declined and drop the cards,
      // without touching the chat history (used when a turn is aborted so a
      // suspended mutating tool can't fire later from a stale card).
      cancelPending: () => {
        for (const resolve of resolvers.values()) resolve(false);
        resolvers.clear();
        set({ pending: [] });
      },
      setBusy: (v) => set({ busy: v }),

      addUser: (content) =>
        set((s) => ({ messages: [...s.messages, { id: uid(), role: 'user', content }] })),

      startAssistant: () => {
        const id = uid();
        set((s) => ({
          messages: [...s.messages, { id, role: 'assistant', content: '', tools: [] }],
        }));
        return id;
      },
      appendAssistant: (id, delta) =>
        set((s) => ({
          messages: patchMessage(s.messages, id, (m) => ({ ...m, content: m.content + delta })),
        })),
      finishAssistant: (id, opts) =>
        set((s) => ({
          messages: patchMessage(s.messages, id, (m) => ({
            ...m,
            done: true,
            error: !!opts?.error,
            // Append the reason instead of dropping it: a turn that streamed a
            // few tokens and THEN failed (429, connection reset) would otherwise
            // render as a truncated answer in red with no explanation at all.
            content: opts?.error
              ? m.content
                ? `${m.content}\n\n${opts.error}`
                : opts.error
              : m.content,
          })),
        })),

      addTool: (msgId, ev) =>
        set((s) => ({
          messages: patchMessage(s.messages, msgId, (m) => ({
            ...m,
            tools: [...(m.tools ?? []), ev],
          })),
        })),
      updateTool: (msgId, evId, patch) =>
        set((s) => ({
          messages: patchMessage(s.messages, msgId, (m) => ({
            ...m,
            tools: (m.tools ?? []).map((t) => (t.id === evId ? { ...t, ...patch } : t)),
          })),
        })),

      requestConfirm: (c) =>
        new Promise<boolean>((resolve) => {
          const id = uid();
          resolvers.set(id, resolve);
          set((s) => ({ pending: [...s.pending, { ...c, id }] }));
        }),
      resolveConfirm: (id, approved) => {
        const resolve = resolvers.get(id);
        if (resolve) {
          resolvers.delete(id);
          resolve(approved);
        }
        set((s) => ({ pending: s.pending.filter((p) => p.id !== id) }));
      },
    }),
    {
      name: COPILOT_STORAGE_KEY,
      version: COPILOT_STORAGE_VERSION,
      storage: createJSONStorage(() => resilientCopilotStorage),
      // Persist the setup but NEVER the API key (or transient chat/confirm state).
      partialize: (s) => persistedCopilotState(s),
      migrate: sanitizedPersistedCopilotState,
      merge: (persisted, current) => {
        const sanitized = sanitizedPersistedCopilotState(persisted);
        return { ...current, config: { ...sanitized.config, apiKey: '' } };
      },
    }
  )
);
