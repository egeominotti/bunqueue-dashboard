import { Unpackr } from 'msgpackr';
import { WORKFLOW_LIMITS } from './types';

const unpackr = new Unpackr({ structuredClone: true });

export function decodeWorkflowValue(
  blob: Uint8Array | null | undefined,
  cap: number,
  label: string
): unknown {
  if (!blob) return null;
  if (!(blob instanceof Uint8Array)) throw new Error(`Workflow ${label} is not a BLOB`);
  if (blob.byteLength > cap) {
    throw new Error(`Workflow ${label} exceeds the ${cap}-byte inspection limit`);
  }
  try {
    return unpackr.unpack(blob);
  } catch (error) {
    throw new Error(`Could not decode workflow ${label}: ${(error as Error).message}`);
  }
}

export function decodeWorkflowObject(
  blob: Uint8Array | null | undefined,
  cap: number,
  label: string
): Record<string, unknown> {
  const value = decodeWorkflowValue(blob, cap, label);
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Workflow ${label} must decode to an object`);
  }
  return value as Record<string, unknown>;
}

/** Convert decoded MessagePack extensions to a bounded, JSON-safe value. */
export function jsonSafeWorkflowValue(value: unknown): unknown {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const visit = (entry: unknown, depth: number): unknown => {
    nodes++;
    if (nodes > WORKFLOW_LIMITS.jsonNodes) throw new Error('Workflow detail exceeds the inspection node limit');
    if (depth > WORKFLOW_LIMITS.jsonDepth) throw new Error('Workflow detail exceeds the inspection depth limit');
    if (entry == null || typeof entry === 'boolean' || typeof entry === 'number') return entry;
    if (typeof entry === 'string') {
      if (entry.length > WORKFLOW_LIMITS.string) throw new Error('Workflow detail contains an oversized string');
      return entry;
    }
    if (typeof entry === 'bigint') return entry.toString();
    if (typeof entry === 'undefined') return null;
    if (typeof entry !== 'object') return String(entry);
    if (seen.has(entry)) throw new Error('Workflow detail contains a cyclic value');
    seen.add(entry);
    try {
      if (entry instanceof Date) return entry.toISOString();
      if (entry instanceof Uint8Array) return `<binary ${entry.byteLength} B>`;
      if (entry instanceof Map) return mapValue(entry, visit, depth);
      if (entry instanceof Set) return [...entry].map((item) => visit(item, depth + 1));
      if (Array.isArray(entry)) return entry.map((item) => visit(item, depth + 1));
      const out = Object.create(null) as Record<string, unknown>;
      for (const [key, item] of Object.entries(entry)) out[key] = visit(item, depth + 1);
      return out;
    } finally {
      seen.delete(entry);
    }
  };
  return visit(value, 0);
}

function mapValue(
  map: Map<unknown, unknown>,
  visit: (entry: unknown, depth: number) => unknown,
  depth: number
): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of map) out[String(key)] = visit(item, depth + 1);
  return out;
}
