import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'default' | 'ghost' | 'accent' | 'danger' | 'warning' | 'success';
type Size = 'sm' | 'md';

const variants: Record<Variant, string> = {
  default: 'border border-line bg-surface-2 text-fg hover:bg-surface-2/70 hover:border-line-strong',
  ghost: 'text-muted hover:text-fg hover:bg-surface-2',
  accent: 'bg-accent text-accent-fg hover:opacity-90 border border-transparent',
  danger: 'border border-red-500/30 text-danger hover:bg-red-500/10 hover:border-red-500/50',
  warning:
    'border border-amber-500/30 text-warning hover:bg-amber-500/10 hover:border-amber-500/50',
  success: 'bg-emerald-500 text-white hover:bg-emerald-500/90 border border-transparent',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
};

export function Button({
  children,
  variant = 'default',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/** Square icon-only button for row actions. */
export function IconButton({
  children,
  className,
  variant = 'ghost',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; children: ReactNode }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-lg transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}
