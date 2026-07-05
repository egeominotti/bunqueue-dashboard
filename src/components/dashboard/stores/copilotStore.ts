import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Copilot chat state. The API key lives in memory only (never persisted — an
 * LLM key in plaintext-at-rest is readable by any same-origin XSS); the provider
 * choice, base URL, and model id ARE persisted so the panel remembers the setup.
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

const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;

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
 * and never expires. Only the non-secret setup (provider/baseURL/model) is kept.
 */
export function persistedCopilotState(s: Pick<CopilotState, 'config'>) {
  return {
    config: { provider: s.config.provider, baseURL: s.config.baseURL, model: s.config.model },
  };
}

export const useCopilotStore = create<CopilotState>()(
  persist(
    (set) => ({
      open: false,
      config: { provider: 'anthropic', baseURL: '', model: 'claude-opus-4-8', apiKey: '' },
      messages: [],
      pending: [],
      busy: false,

      setOpen: (v) => set({ open: v }),
      toggle: () => set((s) => ({ open: !s.open })),
      setConfig: (patch) => set((s) => ({ config: { ...s.config, ...patch } })),
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
            content: opts?.error ? m.content || opts.error : m.content,
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
      name: 'bq-dash-copilot',
      // Persist the setup but NEVER the API key (or transient chat/confirm state).
      partialize: (s) => persistedCopilotState(s),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as { config?: Partial<CopilotConfig> };
        return { ...current, config: { ...current.config, ...(p.config ?? {}), apiKey: '' } };
      },
    }
  )
);
