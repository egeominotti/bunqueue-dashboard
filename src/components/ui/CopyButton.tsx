import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { IconCheck, IconCopy } from './icons';

/** Small icon button that copies `value` to the clipboard and flashes a check mark. */
export function CopyButton({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API unavailable (insecure context, permissions) — fail silently.
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label="Copy to clipboard"
      title="Copy to clipboard"
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-fg',
        className
      )}
    >
      {copied ? (
        <IconCheck className="size-3.5 text-emerald-400" />
      ) : (
        <IconCopy className="size-3.5" />
      )}
    </button>
  );
}
