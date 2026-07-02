import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className="text-[11px] font-medium uppercase tracking-wider text-faint"
    >
      {children}
    </label>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-faint">{hint}</p>}
    </div>
  );
}

const controlClass =
  'h-9 rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg placeholder:text-faint ' +
  'focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30 transition-colors';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(controlClass, 'w-full', className)} {...props} />;
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select className={cn(controlClass, 'w-full cursor-pointer pr-8', className)} {...props}>
      {children}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
        checked ? 'bg-accent' : 'bg-surface-2 border border-line',
        disabled && 'opacity-40'
      )}
    >
      <span
        className={cn(
          'inline-block size-4 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-6' : 'translate-x-1'
        )}
      />
    </button>
  );
}

/** Segmented control (filter tabs like All / Waiting / Active / …). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface p-1">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          disabled={disabled}
          onClick={() => onChange(opt)}
          className={cn(
            'rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors',
            value === opt ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg',
            disabled && 'opacity-40'
          )}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
