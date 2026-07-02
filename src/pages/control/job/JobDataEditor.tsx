import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import type { JobFull } from '@/lib/bqTypes';

/**
 * Editable JSON view of a job's payload. Parses locally (inline error on bad
 * JSON) and hands the parsed value to the parent, which performs the actual
 * `PUT /jobs/:id/data` (bq.updateJobData) through its shared act() flow so
 * success/failure surfaces in the inspector's single status line and the job is
 * reloaded. The textarea re-seeds whenever the loaded job's data changes.
 */
export function JobDataEditor({
  data,
  busy,
  onSave,
}: {
  data: JobFull['data'];
  busy: boolean;
  onSave: (parsed: unknown) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(data ?? null, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const lastSeed = useRef(text);

  useEffect(() => {
    const seed = JSON.stringify(data ?? null, null, 2);
    // Re-seed by CONTENT, not object identity: every act() (Set priority,
    // Retry, Promote…) reloads the job and produces a new `data` reference
    // with the same payload — that must not wipe unsaved edits.
    if (seed === lastSeed.current) return;
    lastSeed.current = seed;
    setText(seed);
    setParseError(null);
  }, [data]);

  const save = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setParseError(`Invalid JSON: ${(e as Error).message}`);
      return;
    }
    setParseError(null);
    onSave(parsed);
  };

  return (
    <Card>
      <CardHeader
        title="Edit data"
        action={
          <Button size="sm" disabled={busy} onClick={save}>
            Save data
          </Button>
        }
      />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={8}
        className="w-full resize-y rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
      />
      {parseError && <p className="mt-2 text-xs text-danger">{parseError}</p>}
    </Card>
  );
}
