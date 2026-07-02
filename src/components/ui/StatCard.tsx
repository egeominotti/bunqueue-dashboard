import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type StatTone = 'default' | 'green' | 'red' | 'blue' | 'amber' | 'accent';

const toneClass: Record<StatTone, string> = {
  default: 'text-fg',
  green: 'text-success',
  red: 'text-danger',
  blue: 'text-blue-400',
  amber: 'text-warning',
  accent: 'text-accent',
};

export function StatCard({
  label,
  value,
  tone = 'default',
  hint,
  compact,
}: {
  label: string;
  value: ReactNode;
  tone?: StatTone;
  hint?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-line bg-surface',
        compact ? 'px-4 py-3' : 'px-5 py-4'
      )}
    >
      <div className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</div>
      <div
        className={cn('mt-2 font-semibold tnum', compact ? 'text-xl' : 'text-3xl', toneClass[tone])}
      >
        {value}
      </div>
      {hint != null && <div className="mt-1 text-xs text-faint">{hint}</div>}
    </div>
  );
}
