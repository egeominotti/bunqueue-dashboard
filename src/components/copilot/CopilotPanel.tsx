import { useEffect, useRef, useState } from 'react';
import { useCopilotStore } from '@/components/dashboard/stores/copilotStore';
import { Field, Input, Select } from '@/components/ui/form';
import { normalizeCustomProviderBaseURL, PROVIDERS, providerById } from '@/lib/copilot/providers';
import { abortActive, clearChat, sendMessage } from '@/lib/copilot/runtime';
import { ConfirmCard, MessageBubble, PanelIconButton } from './CopilotPanelParts';

const SUGGESTIONS = [
  'Which queues are backing up right now?',
  'Show DLQ stats for every queue and what is failing.',
  'Summarize server health and worker status.',
];

export function CopilotPanel() {
  const { config, setConfig, messages, pending, busy, setOpen, resolveConfirm } = useCopilotStore();
  const def = providerById(config.provider);
  const customBaseValid =
    config.provider !== 'custom' || normalizeCustomProviderBaseURL(config.baseURL) !== null;
  const configured =
    config.apiKey.trim().length > 0 && config.model.trim().length > 0 && customBaseValid;

  const [input, setInput] = useState('');
  const [showConfig, setShowConfig] = useState(!configured);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  // Scroll to the latest message whenever new content arrives.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, pending]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  useEffect(() => {
    dialogRef.current
      ?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled])')
      ?.focus();
  }, []);

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || busy || !configured) return;
    setInput('');
    void sendMessage(t);
  };

  const changeProvider = (id: string) => {
    const p = providerById(id);
    setConfig({
      provider: id,
      // Named providers use their code-defined endpoint. Never copy it into the
      // editable/persisted field where a stale value could later look trusted.
      baseURL: '',
      model: p?.models[0] ?? '',
    });
  };

  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close Copilot"
        onClick={() => setOpen(false)}
        className="fixed inset-0 z-[55] cursor-default bg-black/30"
      />
      <aside
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Copilot"
        className="fixed inset-y-0 right-0 z-[60] flex w-full max-w-md flex-col border-l border-line bg-surface shadow-xl"
      >
        {/* Header */}
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="font-semibold text-fg">Copilot</span>
          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
            experimental
          </span>
          <div className="ml-auto flex items-center gap-1">
            <PanelIconButton
              label="Settings"
              active={showConfig}
              onClick={() => setShowConfig((v) => !v)}
            >
              <path d="M10 4a2 2 0 014 0 6 6 0 012.6 1.5 2 2 0 002.7 2.7 6 6 0 010 3.6 2 2 0 00-2.7 2.7A6 6 0 0114 18a2 2 0 01-4 0 6 6 0 01-2.6-1.5 2 2 0 00-2.7-2.7 6 6 0 010-3.6 2 2 0 002.7-2.7A6 6 0 0110 4z" />
              <circle cx="12" cy="12" r="2.5" />
            </PanelIconButton>
            <PanelIconButton
              label="Clear chat"
              onClick={() => {
                if (
                  messages.length === 0 ||
                  window.confirm('Clear the entire Copilot conversation from this browser?')
                ) {
                  clearChat();
                }
              }}
            >
              <path d="M6 7h12M9 7V5h6v2m-7 0v11a1 1 0 001 1h6a1 1 0 001-1V7" />
            </PanelIconButton>
            <PanelIconButton label="Close" onClick={() => setOpen(false)}>
              <path d="M6 6l12 12M18 6L6 18" />
            </PanelIconButton>
          </div>
        </header>

        {showConfig && (
          <div className="space-y-3 border-b border-line bg-surface-2/50 px-4 py-3">
            <Field label="Provider">
              <Select
                name="copilot-provider"
                autoComplete="off"
                value={config.provider}
                onChange={(e) => changeProvider(e.target.value)}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            {def?.id === 'custom' && (
              <Field label="Base URL">
                <Input
                  name="copilot-base-url"
                  value={config.baseURL}
                  onChange={(e) => setConfig({ baseURL: e.target.value })}
                  placeholder="https://api.example.com/v1"
                  autoComplete="off"
                  inputMode="url"
                  spellCheck={false}
                />
                {!customBaseValid && (
                  <span className="text-xs text-warning">
                    Enter a full http(s) endpoint without credentials, query, or fragment.
                  </span>
                )}
              </Field>
            )}
            <Field label="Model" htmlFor="copilot-model">
              <Input
                id="copilot-model"
                name="copilot-model"
                list="copilot-models"
                value={config.model}
                onChange={(e) => setConfig({ model: e.target.value })}
                placeholder="model id"
                autoComplete="off"
                spellCheck={false}
              />
              <datalist id="copilot-models">
                {(def?.models ?? []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
            <Field label="API key">
              <Input
                name="copilot-api-key"
                type="password"
                value={config.apiKey}
                onChange={(e) => setConfig({ apiKey: e.target.value })}
                placeholder="your provider API key"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <p className="text-xs text-faint">
              Chat and tool results (live queue/job data) are sent directly from your browser to the
              provider you configure.
            </p>
            <p className="text-xs text-faint">
              Key stays in memory for this session only, never saved to disk.{' '}
              {def?.keyUrl && (
                <a
                  href={def.keyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  Get a key
                </a>
              )}
            </p>
            {def && !def.browserDirect && (
              <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                {def.note ?? 'This provider may block direct browser calls (CORS).'}
              </p>
            )}
          </div>
        )}

        {/* Messages */}
        <div
          ref={scrollRef}
          aria-live="polite"
          className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4"
        >
          {messages.length === 0 && (
            <div className="space-y-3 pt-6">
              <p className="text-sm text-muted">
                Ask about your queues, jobs, DLQ, workers, or crons. I read live data and can
                propose only promote and pause/resume. Every action names its target server and
                waits for your confirmation.
              </p>
              <div className="space-y-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    type="button"
                    key={s}
                    onClick={() => submit(s)}
                    disabled={!configured}
                    className="block w-full rounded-lg border border-line px-3 py-2 text-left text-sm text-muted transition-colors hover:border-accent/50 hover:text-fg disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
              {!configured && (
                <p className="text-xs text-warning">
                  Set a provider, model, and API key above to start.
                </p>
              )}
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
        </div>

        {/* Pending confirmations pinned above the input */}
        {pending.length > 0 && (
          <div className="space-y-2 border-t border-line px-4 py-3">
            {pending.map((p) => (
              <ConfirmCard
                key={p.id}
                confirm={p}
                onConfirm={() => resolveConfirm(p.id, true)}
                onDecline={() => resolveConfirm(p.id, false)}
              />
            ))}
          </div>
        )}

        {/* Input */}
        <div className="border-t border-line px-4 py-3">
          <div className="flex items-end gap-2">
            <textarea
              name="copilot-message"
              aria-label="Message to Copilot"
              autoComplete="off"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit(input);
                }
              }}
              rows={2}
              placeholder={configured ? 'Ask the Copilot…' : 'Add an API key in settings first'}
              disabled={!configured}
              className="min-h-0 flex-1 resize-none rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
            />
            {busy ? (
              <button
                type="button"
                onClick={() => abortActive()}
                className="rounded-lg border border-line px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-fg"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => submit(input)}
                disabled={!input.trim() || !configured}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
