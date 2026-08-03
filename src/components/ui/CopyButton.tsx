import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { IconCheck, IconClose, IconCopy } from './icons';

/** Copy `value` via the legacy hidden-textarea path (insecure-context fallback). */
function execCommandCopy(value: string): boolean {
  let ta: HTMLTextAreaElement | null = null;
  try {
    ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta?.remove();
  }
}

/**
 * Small icon button that copies `value` to the clipboard and flashes a check
 * mark — or a red ✕ when the copy failed, so the user never pastes stale
 * clipboard contents believing the copy worked. navigator.clipboard is
 * undefined on insecure (plain-HTTP, non-localhost) origins — the documented
 * Docker/nginx deployment — so it falls back to execCommand('copy') there.
 */
export function CopyButton({ value, className }: { value: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const copy = async () => {
    let ok = false;
    if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(value);
        ok = true;
      } catch {
        // Permission denied / transient failure — try the legacy path below.
      }
    }
    if (!ok) ok = execCommandCopy(value);
    setState(ok ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  };

  const accessibleLabel =
    state === 'copied'
      ? 'Copied to clipboard'
      : state === 'failed'
        ? 'Copy failed'
        : 'Copy to clipboard';

  return (
    <>
      <button
        type="button"
        onClick={copy}
        aria-label={accessibleLabel}
        title={accessibleLabel}
        className={cn(
          'inline-flex size-6 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-fg',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          className
        )}
      >
        {state === 'copied' ? (
          <IconCheck className="size-3.5 text-success" />
        ) : state === 'failed' ? (
          <IconClose className="size-3.5 text-danger" />
        ) : (
          <IconCopy className="size-3.5" />
        )}
      </button>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {state === 'idle' ? '' : accessibleLabel}
      </span>
    </>
  );
}
