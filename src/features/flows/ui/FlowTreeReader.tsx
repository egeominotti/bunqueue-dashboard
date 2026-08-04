import { useState } from 'react';
import type { FlowOperationsRepository, FlowTarget } from '../application/FlowOperationsRepository';
import { flowStateStyle } from '../domain/flowConstants';
import { bqFlowOperationsRepository } from '../infrastructure/bqFlowOperationsRepository';
import { FlowJson } from './FlowJson';
import { FlowTargetFields } from './FlowTargetFields';
import { flowRequestKey, useLatestFlowRequest } from './useLatestFlowRequest';

interface LoadedTree {
  target: FlowTarget;
  depth: number;
  maxChildren: number;
  value: unknown;
}

interface TreeRow {
  id: string;
  name: string;
  queueName: string;
  state: string;
  level: number;
}

export function FlowTreeReader({
  repository = bqFlowOperationsRepository,
  target,
  onTargetChange,
}: {
  repository?: FlowOperationsRepository;
  target: FlowTarget;
  onTargetChange: (target: FlowTarget) => void;
}) {
  const [depth, setDepth] = useState('10');
  const [maxChildren, setMaxChildren] = useState('100');
  const request = useLatestFlowRequest<LoadedTree>(
    flowRequestKey(target.id, target.queueName, depth, maxChildren)
  );
  const loading = Boolean(request.busy);
  const valid =
    Boolean(target.id.trim() && target.queueName.trim()) &&
    validTreeLimit(depth) &&
    validTreeLimit(maxChildren);
  const load = async () => {
    if (!valid) return;
    const pinned = {
      target: { id: target.id.trim(), queueName: target.queueName.trim() },
      depth: Number(depth),
      maxChildren: Number(maxChildren),
    };
    await request.run('getFlow', async () => {
      const value = await repository.getFlow({
        ...pinned.target,
        depth: pinned.depth,
        maxChildren: pinned.maxChildren,
      });
      return { ...pinned, value };
    });
  };
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-fg">FlowProducer.getFlow</h2>
          <p className="mt-1 text-xs text-faint">
            Read the broker-native tree with explicit traversal limits. Results are bound to the
            target and limits that produced them.
          </p>
        </div>
        <button
          type="button"
          disabled={!valid || loading}
          onClick={() => void load()}
          className="rounded-md bg-accent px-3 py-2 text-xs font-medium text-accent-fg disabled:opacity-40"
        >
          {loading ? 'Loading tree...' : 'Load getFlow tree'}
        </button>
      </div>
      <div className="mt-4">
        <FlowTargetFields target={target} onChange={onTargetChange} />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <LimitField label="Depth" value={depth} onChange={setDepth} />
        <LimitField label="Children per level" value={maxChildren} onChange={setMaxChildren} />
      </div>
      <p className="mt-2 text-[11px] text-faint">Both limits accept integers from 0 to 500.</p>
      {request.error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {request.error}
        </p>
      )}
      {request.result && <TreeResult loaded={request.result} />}
    </section>
  );
}

function LimitField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-xs text-faint">
      {label}
      <input
        aria-label={`getFlow ${label}`}
        type="number"
        min="0"
        max="500"
        step="1"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg"
      />
    </label>
  );
}

function TreeResult({ loaded }: { loaded: LoadedTree }) {
  const root = flowRoot(loaded.value);
  const rows = root ? flattenTree(root) : [];
  return (
    <div className="mt-4 border-t border-line pt-4" aria-live="polite">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-mono text-fg">
          {loaded.target.queueName}/{loaded.target.id}
        </span>
        <span className="text-faint">
          depth {loaded.depth}, max children {loaded.maxChildren}
        </span>
      </div>
      {root === null ? (
        <p className="rounded-md border border-line bg-bg p-3 text-sm text-muted">
          Bunqueue returned no flow for this target.
        </p>
      ) : rows.length > 0 ? (
        <ul
          aria-label="getFlow tree result"
          className="max-h-72 overflow-auto rounded-md border border-line bg-bg"
        >
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex min-w-max items-center gap-2 border-b border-line/60 px-3 py-2 last:border-b-0"
              style={{ paddingLeft: `${12 + Math.min(row.level, 20) * 18}px` }}
            >
              <span
                className={`rounded border px-1.5 py-0.5 text-[10px] ${flowStateStyle(row.state)}`}
              >
                {row.state}
              </span>
              <span className="font-mono text-xs text-fg">{row.id}</span>
              <span className="text-xs text-muted">{row.name}</span>
              <span className="text-[11px] text-faint">{row.queueName}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p role="alert" className="rounded-md border border-warning/40 p-3 text-sm text-warning">
          The agent returned an unrecognized getFlow payload. Inspect the raw JSON below.
        </p>
      )}
      <details className="mt-3" open>
        <summary className="cursor-pointer text-xs font-medium text-muted">
          Raw getFlow JSON
        </summary>
        <div className="mt-2">
          <FlowJson value={loaded.value} />
        </div>
      </details>
    </div>
  );
}

function flowRoot(value: unknown): Record<string, unknown> | null | undefined {
  const envelope = record(value);
  const result = record(envelope?.result) ?? envelope;
  if (!result || !Object.hasOwn(result, 'flow')) return undefined;
  if (result.flow === null) return null;
  return record(result.flow);
}

function flattenTree(root: Record<string, unknown>): TreeRow[] {
  const rows: TreeRow[] = [];
  const pending = [{ node: root, level: 0 }];
  const seen = new WeakSet<object>();
  while (pending.length > 0 && rows.length < 1_000) {
    const current = pending.shift();
    if (!current || seen.has(current.node)) continue;
    seen.add(current.node);
    rows.push({
      id: textValue(current.node.id, '(missing id)'),
      name: textValue(current.node.name, '(unnamed)'),
      queueName: textValue(current.node.queueName, '(missing queue)'),
      state: textValue(current.node.state, 'unknown'),
      level: current.level,
    });
    const children = Array.isArray(current.node.children) ? current.node.children : [];
    pending.unshift(
      ...children
        .map(record)
        .filter((child): child is Record<string, unknown> => child !== undefined)
        .map((node) => ({ node, level: current.level + 1 }))
    );
  }
  return rows;
}

const validTreeLimit = (value: string) => /^\d+$/.test(value) && Number(value) <= 500;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const textValue = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.length > 0 ? value : fallback;
