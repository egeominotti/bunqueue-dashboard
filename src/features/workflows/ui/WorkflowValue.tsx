import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { cn } from '@/lib/cn';

const json = (value: unknown) => JSON.stringify(value, null, 2) ?? 'null';

export function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <Card className="min-w-0">
      <div className="text-xs font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className={cn('mt-2 tnum text-2xl font-semibold text-fg', tone)}>{value}</div>
    </Card>
  );
}

export function JsonBlock({ value, empty = 'None' }: { value: unknown; empty?: string }) {
  const absent = value == null || (typeof value === 'object' && Object.keys(value).length === 0);
  if (absent) return <p className="text-xs text-faint">{empty}</p>;
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs leading-5 text-muted">
      {json(value)}
    </pre>
  );
}

export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-faint">{label}</dt>
      <dd className="mt-0.5 break-words text-muted">{value}</dd>
    </div>
  );
}
