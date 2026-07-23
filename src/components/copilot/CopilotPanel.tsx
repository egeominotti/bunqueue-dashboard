import { useEffect, useRef, useState } from 'react';
import {
  type ChatMessage,
  type PendingConfirm,
  type ToolEvent,
  useCopilotStore,
} from '@/components/dashboard/stores/copilotStore';
import { Field, Input, Select } from '@/components/ui/form';
import { cn } from '@/lib/cn';
import { PROVIDERS, providerById } from '@/lib/copilot/providers';
import { abortActive, clearChat, sendMessage } from '@/lib/copilot/runtime';

const SUGGESTIONS = [
  'Which queues are backing up right now?',
  'Show DLQ stats for every queue and what is failing.',
  'Summarize server health and worker status.',
];

const STATUS_STYLE: Record<ToolEvent['status'], string> = {
  awaiting: 'border-warning/40 text-warning',
  running: 'border-accent/40 text-accent',
  done: 'border-success/40 text-success',
  error: 'border-danger/40 text-danger',
  declined: 'border-line text-faint',
};

export function CopilotPanel() {
  const { config, setConfig, messages, pending, busy, setOpen, resolveConfirm } = useCopilotStore();
  const def = providerById(config.provider);
  const configured = config.apiKey.trim().length > 0 && config.model.trim().length > 0;

  const [input, setInput] = useState('');
  const [showConfig, setShowConfig] = useState(!configured);
  const scrollRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, pending]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

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
      baseURL: p?.baseURL ?? '',
      model: p?.models[0] ?? '',
    });
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close Copilot"
        onClick={() => setOpen(false)}
        className="fixed inset-0 z-[55] cursor-default bg-black/30"
      />
      <aside
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
            <IconButton
              label="Settings"
              active={showConfig}
              onClick={() => setShowConfig((v) => !v)}
            >
              <path d="M10 4a2 2 0 014 0 6 6 0 012.6 1.5 2 2 0 002.7 2.7 6 6 0 010 3.6 2 2 0 00-2.7 2.7A6 6 0 0114 18a2 2 0 01-4 0 6 6 0 01-2.6-1.5 2 2 0 00-2.7-2.7 6 6 0 010-3.6 2 2 0 002.7-2.7A6 6 0 0110 4z" />
              <circle cx="12" cy="12" r="2.5" />
            </IconButton>
            <IconButton label="Clear chat" onClick={clearChat}>
              <path d="M6 7h12M9 7V5h6v2m-7 0v11a1 1 0 001 1h6a1 1 0 001-1V7" />
            </IconButton>
            <IconButton label="Close" onClick={() => setOpen(false)}>
              <path d="M6 6l12 12M18 6L6 18" />
            </IconButton>
          </div>
        </header>

        {showConfig && (
          <div className="space-y-3 border-b border-line bg-surface-2/50 px-4 py-3">
            <Field label="Provider">
              <Select value={config.provider} onChange={(e) => changeProvider(e.target.value)}>
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            {def?.kind === 'compatible' && (
              <Field label="Base URL">
                <Input
                  value={config.baseURL}
                  onChange={(e) => setConfig({ baseURL: e.target.value })}
                  placeholder="https://api.example.com/v1"
                  spellCheck={false}
                />
              </Field>
            )}
            <Field label="Model">
              <Input
                list="copilot-models"
                value={config.model}
                onChange={(e) => setConfig({ model: e.target.value })}
                placeholder="model id"
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
          className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
        >
          {messages.length === 0 && (
            <div className="space-y-3 pt-6">
              <p className="text-sm text-muted">
                Ask about your queues, jobs, DLQ, workers, or crons. I read live data and can
                propose actions (retry, pause, purge) that you confirm before they run.
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

function IconButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        'rounded-md p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg',
        active && 'bg-surface-2 text-fg'
      )}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-4"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] space-y-2',
          isUser ? 'rounded-2xl rounded-br-sm bg-accent/15 px-3 py-2' : 'w-full'
        )}
      >
        {(message.tools?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {message.tools?.map((t) => (
              <span
                key={t.id}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
                  STATUS_STYLE[t.status]
                )}
                title={t.error || (t.mutates ? 'mutating action' : 'read')}
              >
                {t.mutates && <span aria-hidden="true">●</span>}
                {t.label}
                {t.status === 'declined' && ' (declined)'}
                {t.status === 'error' && ' (failed)'}
              </span>
            ))}
          </div>
        )}
        {message.content && (
          <div
            className={cn(
              'whitespace-pre-wrap break-words text-sm',
              message.error ? 'text-danger' : 'text-fg'
            )}
          >
            {message.content}
          </div>
        )}
        {!message.content && !isUser && (message.tools?.length ?? 0) === 0 && (
          <div className="text-sm text-faint">{message.done ? 'Stopped.' : 'Thinking…'}</div>
        )}
      </div>
    </div>
  );
}

function ConfirmCard({
  confirm,
  onConfirm,
  onDecline,
}: {
  confirm: PendingConfirm;
  onConfirm: () => void;
  onDecline: () => void;
}) {
  const args = confirm.args as Record<string, unknown> | undefined;
  return (
    <div className="rounded-lg border border-warning/50 bg-warning/10 px-3 py-2">
      <div className="text-sm font-medium text-fg">Confirm: {confirm.label}</div>
      {args && Object.keys(args).length > 0 && (
        <div className="mt-1 font-mono text-xs text-muted">
          {Object.entries(args)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join('  ·  ')}
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90"
        >
          Confirm
        </button>
        <button
          type="button"
          onClick={onDecline}
          className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
        >
          Decline
        </button>
      </div>
    </div>
  );
}
