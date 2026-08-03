import {
  cloneElement,
  type InputHTMLAttributes,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  useId,
} from 'react';
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
  htmlFor: explicitHtmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  /** Required when `children` is a compound control rather than one Input/Select. */
  htmlFor?: string;
  children: ReactNode;
}) {
  const autoId = useId();
  // Wire label→control (htmlFor/id) when there's a single element child — the
  // common case. An explicit id is respected; multi-node children (e.g. the
  // env-vars editor) keep the visual label only, as before.
  let control: ReactNode = children;
  let htmlFor = explicitHtmlFor;
  if (!explicitHtmlFor && isValidElement(children)) {
    const el = children as ReactElement<{ id?: string }>;
    // Do not point a <label> at a layout wrapper (`<div>`, `<span>`, …). Compound
    // fields must provide htmlFor explicitly so the label targets the actual
    // input instead of a non-labellable element.
    const labellableControl =
      (typeof el.type === 'string' && ['input', 'select', 'textarea'].includes(el.type)) ||
      el.type === Input ||
      el.type === Select;
    if (labellableControl) {
      htmlFor = el.props.id ?? autoId;
      control = el.props.id ? el : cloneElement(el, { id: autoId });
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {control}
      {hint && <p className="text-xs leading-relaxed text-faint">{hint}</p>}
    </div>
  );
}

const controlClass =
  'h-9 rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg placeholder:text-faint ' +
  'transition-colors focus-visible:border-accent focus-visible:outline-2 ' +
  'focus-visible:outline-offset-2 focus-visible:outline-accent';

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
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
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
  label = 'View options',
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  /** Accessible name for this mutually exclusive group. */
  label?: string;
}) {
  return (
    <fieldset className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface p-1">
      <legend className="sr-only">{label}</legend>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          aria-pressed={value === opt}
          disabled={disabled}
          onClick={() => onChange(opt)}
          className={cn(
            'rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
            value === opt ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg',
            disabled && 'opacity-40'
          )}
        >
          {opt}
        </button>
      ))}
    </fieldset>
  );
}
