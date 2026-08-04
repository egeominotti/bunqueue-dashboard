import { useState } from 'react';
import type { FlowOperationsRepository } from '../application/FlowOperationsRepository';
import { bqFlowOperationsRepository } from '../infrastructure/bqFlowOperationsRepository';
import { FlowJson } from './FlowJson';
import { flowRequestKey, useLatestFlowRequest } from './useLatestFlowRequest';

export function FlowParentResults({
  repository = bqFlowOperationsRepository,
  initialIds = '',
}: {
  repository?: FlowOperationsRepository;
  initialIds?: string;
}) {
  const [source, setSource] = useState(initialIds);
  const request = useLatestFlowRequest<unknown>(flowRequestKey(source));
  const busy = request.busy;
  const ids = parseIds(source);

  const run = async (operation: 'one' | 'many') => {
    if (ids.length === 0) return;
    const pinnedIds = [...ids];
    await request.run(operation, async () =>
      operation === 'one'
        ? await repository.getParentResult(pinnedIds[0])
        : await repository.getParentResults(pinnedIds)
    );
  };

  return (
    <section className="grid gap-5 rounded-lg border border-line bg-surface p-4 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.2fr)]">
      <div>
        <h2 className="text-sm font-semibold text-fg">Parent results</h2>
        <p className="mt-1 text-xs text-faint">
          Resolve completed parent values through the official FlowProducer result API.
        </p>
        <label className="mt-4 block text-xs text-faint">
          Parent IDs, one per line
          <textarea
            aria-label="Flow parent IDs"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder={'parent-job-id\nanother-parent-id'}
            className="mt-1 min-h-28 w-full resize-y rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs text-fg"
          />
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={ids.length === 0 || Boolean(busy)}
            onClick={() => void run('one')}
            className="rounded-md border border-line px-3 py-1.5 font-mono text-xs text-muted disabled:opacity-40"
          >
            getParentResult
          </button>
          <button
            type="button"
            disabled={ids.length === 0 || Boolean(busy)}
            onClick={() => void run('many')}
            className="rounded-md border border-line px-3 py-1.5 font-mono text-xs text-muted disabled:opacity-40"
          >
            getParentResults ({ids.length})
          </button>
        </div>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-fg">Resolved values</h3>
        <p className="mt-1 mb-4 text-xs text-faint">
          {busy ? 'Reading durable results…' : 'Falsy values and input ordering are preserved.'}
        </p>
        {request.error && (
          <p role="alert" className="mb-3 text-sm text-danger">
            {request.error}
          </p>
        )}
        {request.result === undefined ? (
          <p className="text-sm text-muted">No parent result requested.</p>
        ) : (
          <FlowJson value={request.result} />
        )}
      </div>
    </section>
  );
}

function parseIds(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 1_000);
}
