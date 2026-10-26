import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/form';
import type { DiscoveryQuery } from './model';
import { loadSavedViews, saveSavedViews } from './savedViews';

export function SavedViews({
  query,
  onLoad,
}: {
  query: DiscoveryQuery;
  onLoad: (query: DiscoveryQuery) => void;
}) {
  const [views, setViews] = useState(loadSavedViews);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const store = (next: typeof views) => {
    if (saveSavedViews(next)) {
      setViews(next);
      setError('');
    } else
      setError(
        'Could not save locally. Storage must be available; at most 32 views and 32 KiB are supported.'
      );
  };
  return (
    <Card>
      <p className="mb-3 text-xs text-muted">
        Saved views stay in this browser and contain only filter preferences.
      </p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          store([
            ...views.filter((view) => view.name !== name.trim()),
            { name: name.trim(), query },
          ]);
        }}
      >
        <Field label="Saved view name">
          <Input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Button type="submit" disabled={!name.trim()}>
          Save view
        </Button>
      </form>
      <ul className="mt-3 flex flex-wrap gap-3">
        {views.map((view) => (
          <li key={view.name} className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => onLoad(view.query)}>
              {view.name}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Delete view ${view.name}`}
              onClick={() => store(views.filter((candidate) => candidate !== view))}
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Card>
  );
}
