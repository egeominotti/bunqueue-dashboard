import type {
  ChatMessage,
  PendingConfirm,
  ToolEvent,
} from '@/components/dashboard/stores/copilotStore';
import { cn } from '@/lib/cn';

const STATUS_STYLE: Record<ToolEvent['status'], string> = {
  awaiting: 'border-warning/40 text-warning',
  running: 'border-accent/40 text-accent',
  done: 'border-success/40 text-success',
  error: 'border-danger/40 text-danger',
  declined: 'border-line text-faint',
};

export function PanelIconButton({
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
      aria-pressed={active ?? undefined}
      onClick={onClick}
      className={cn(
        'rounded-md p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
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

export function MessageBubble({ message }: { message: ChatMessage }) {
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
            {message.tools?.map((tool) => (
              <span
                key={tool.id}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
                  STATUS_STYLE[tool.status]
                )}
                title={tool.error || (tool.mutates ? 'mutating action' : 'read')}
              >
                {tool.mutates && <span aria-hidden="true">●</span>}
                {tool.label}
                {tool.status === 'declined' && ' (declined)'}
                {tool.status === 'error' && ' (failed)'}
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

export function ConfirmCard({
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
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${key}: ${String(value)}`)
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
