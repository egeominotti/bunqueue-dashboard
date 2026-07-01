import type { ReactNode } from 'react';
import { StatusDot } from './StatusBadge';

export function PageHeader({
  title,
  description,
  live,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  live?: boolean;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        {back}
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-fg">{title}</h1>
            {live && <StatusDot label="Live" tone="green" />}
          </div>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
