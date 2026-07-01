import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div className={cn('rounded-xl border border-line bg-surface', padded && 'p-5', className)}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  action,
  icon,
}: {
  title: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h3 className="flex items-center gap-2 text-base font-semibold text-fg">
        {icon}
        {title}
      </h3>
      {action}
    </div>
  );
}

/** Section title used above tables/blocks on a page. */
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold text-fg">{children}</h2>
      {action}
    </div>
  );
}
