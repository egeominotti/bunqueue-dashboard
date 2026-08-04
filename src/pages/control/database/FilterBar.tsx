import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/form';
import { IconSearch } from '@/components/ui/icons';
import type { DbFilter } from '@/lib/bq';

export function FilterBar({
  columns,
  filter,
  onChange,
}: {
  columns: string[];
  filter: DbFilter | null;
  onChange: (f: DbFilter | null) => void;
}) {
  const [col, setCol] = useState(filter?.column ?? '');
  const [op, setOp] = useState<DbFilter['op']>(filter?.op ?? 'contains');
  const [value, setValue] = useState(filter?.value ?? '');

  const effCol = col || columns[0] || '';
  const apply = () => onChange(value.trim() ? { column: effCol, op, value: value.trim() } : null);
  const clear = () => {
    setValue('');
    onChange(null);
  };

  if (columns.length === 0) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="w-40">
        <Select
          value={effCol}
          aria-label="Filter column"
          name="database-filter-column"
          autoComplete="off"
          onChange={(e) => setCol(e.target.value)}
        >
          {columns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-32">
        <Select
          value={op}
          aria-label="Filter operator"
          name="database-filter-operator"
          autoComplete="off"
          onChange={(e) => setOp(e.target.value as DbFilter['op'])}
        >
          <option value="contains">contains</option>
          <option value="eq">=</option>
          <option value="ne">≠</option>
        </Select>
      </div>
      <div className="relative min-w-40 flex-1">
        <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && apply()}
          aria-label="Filter value"
          name="database-filter-value"
          autoComplete="off"
          placeholder="value — Enter to filter"
          className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-3 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
      </div>
      <Button size="sm" onClick={apply} disabled={!value.trim()}>
        Filter
      </Button>
      {filter && (
        <Button size="sm" variant="ghost" onClick={clear}>
          Clear
        </Button>
      )}
      <span className="text-[11px] text-faint">filters the whole table, server-side</span>
    </div>
  );
}
