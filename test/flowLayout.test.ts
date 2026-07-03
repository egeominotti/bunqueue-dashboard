import { describe, expect, it } from 'bun:test';
import { computeLayers, type FlowEdge, layoutDag } from '../src/lib/flowLayout';

const child = (from: string, to: string): FlowEdge => ({ from, to, kind: 'child' });

describe('computeLayers', () => {
  it('lays a linear chain out one layer per hop', () => {
    const layers = computeLayers(['a', 'b', 'c'], [child('a', 'b'), child('b', 'c')]);
    expect(layers.get('a')).toBe(0);
    expect(layers.get('b')).toBe(1);
    expect(layers.get('c')).toBe(2);
  });

  it('uses the LONGEST path for a diamond (b and c on layer 1, d on layer 2)', () => {
    const edges = [child('a', 'b'), child('a', 'c'), child('b', 'd'), child('c', 'd')];
    const layers = computeLayers(['a', 'b', 'c', 'd'], edges);
    expect(layers.get('a')).toBe(0);
    expect(layers.get('b')).toBe(1);
    expect(layers.get('c')).toBe(1);
    expect(layers.get('d')).toBe(2);
  });

  it('keeps isolated nodes at layer 0', () => {
    const layers = computeLayers(['solo', 'x', 'y'], [child('x', 'y')]);
    expect(layers.get('solo')).toBe(0);
  });

  it('does not hang on a cycle and still returns a layer for every node', () => {
    const layers = computeLayers(['a', 'b'], [child('a', 'b'), child('b', 'a')]);
    expect(layers.size).toBe(2);
    expect(layers.get('a')).toBeGreaterThanOrEqual(0);
    expect(layers.get('b')).toBeGreaterThanOrEqual(0);
  });

  it('ignores self-loops and edges to unknown nodes', () => {
    const layers = computeLayers(
      ['a', 'b'],
      [child('a', 'a'), child('a', 'ghost'), child('a', 'b')]
    );
    expect(layers.get('a')).toBe(0);
    expect(layers.get('b')).toBe(1);
  });
});

describe('layoutDag', () => {
  it('positions every node once with a positive canvas size', () => {
    const ids = ['a', 'b', 'c'];
    const { nodes, width, height } = layoutDag(ids, [child('a', 'b'), child('b', 'c')]);
    expect(nodes.map((n) => n.id).sort()).toEqual([...ids].sort());
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  it('places each layer in its own column (same x, increasing across layers)', () => {
    const { nodes } = layoutDag(
      ['a', 'b', 'c', 'd'],
      [child('a', 'b'), child('a', 'c'), child('b', 'd'), child('c', 'd')]
    );
    const x = (id: string) => nodes.find((n) => n.id === id)?.x ?? -1;
    expect(x('b')).toBe(x('c')); // same layer -> same column
    expect(x('a')).toBeLessThan(x('b')); // parent column is left of children
    expect(x('d')).toBeGreaterThan(x('b'));
  });

  it('stacks siblings in the same column at distinct y positions', () => {
    const { nodes } = layoutDag(['a', 'b', 'c'], [child('a', 'b'), child('a', 'c')]);
    const yb = nodes.find((n) => n.id === 'b')?.y;
    const yc = nodes.find((n) => n.id === 'c')?.y;
    expect(yb).not.toBe(yc);
  });
});
