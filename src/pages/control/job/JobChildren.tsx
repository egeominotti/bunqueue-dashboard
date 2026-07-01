import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { bq } from '@/lib/bq';

/**
 * Collapsible view of a flow parent's resolved child values, from
 * `GET /jobs/:id/children` (bq.jobChildren → { values }). Only meaningful for a
 * job that has children; the parent renders it just for those. Values are
 * fetched lazily on first expand.
 */
export function JobChildren({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [values, setValues] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await bq.jobChildren(jobId);
      setValues(r.data?.values);
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !loaded && !loading) load();
  };

  const count =
    values && typeof values === 'object'
      ? Array.isArray(values)
        ? values.length
        : Object.keys(values as Record<string, unknown>).length
      : 0;

  return (
    <Card>
      <CardHeader
        title="Child values"
        action={
          <Button size="sm" variant="ghost" onClick={toggle}>
            {open ? 'Hide' : 'Show'}
          </Button>
        }
      />
      {!open ? (
        <p className="text-xs text-faint">Resolved return values from this flow job's children.</p>
      ) : loading ? (
        <p className="text-xs text-faint">Loading child values…</p>
      ) : error ? (
        <p className="text-xs text-red-400">{error}</p>
      ) : count === 0 ? (
        <p className="text-xs text-faint">No child values available.</p>
      ) : (
        <pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs text-muted">
          {JSON.stringify(values, null, 2)}
        </pre>
      )}
    </Card>
  );
}
