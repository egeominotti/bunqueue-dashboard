import type { ElementType, ReactNode } from 'react';
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
  headingLevel = 2,
}: {
  title: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  /** Match the card to the surrounding document outline. Page-level cards are h2 by default. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
}) {
  const Heading = `h${headingLevel}` as ElementType;
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <Heading className="flex items-center gap-2 text-base font-semibold text-fg">
        {icon}
        {title}
      </Heading>
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
