import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../../db/index.js';
import type {
  ConfidenceClass,
  EdgeType,
  FreshnessStatus,
  NodeOrigin,
} from '../../../../db/types.js';
import {
  DEFAULT_TRAVERSAL_OPTIONS,
  adjacentNode,
  edgesFor,
  traversalKey,
  traverseFrom,
} from '../index.js';

let root: string;
let db: LuxDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-traversal-'));
  db = new LuxDatabase(join(root, 'lux.db'));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function addNode(id: string, options: { origin?: NodeOrigin; qualifiedName?: string } = {}): void {
  db.upsertStructuralNode({
    id,
    node_type: 'symbol',
    symbol_name: id,
    qualified_name: options.qualifiedName,
    origin: options.origin ?? 'local',
    updated_at: 1,
  });
}

function addEdge(
  source: string,
  target: string,
  options: {
    id?: string;
    edgeType?: EdgeType;
    confidence?: number;
    confidenceClass?: ConfidenceClass;
    freshness?: FreshnessStatus;
  } = {}
): void {
  const edgeType = options.edgeType ?? 'calls';
  db.upsertStructuralEdge({
    id: options.id ?? `${source}->${target}:${edgeType}`,
    source_node_id: source,
    target_node_id: target,
    edge_type: edgeType,
    confidence: options.confidence ?? 0.9,
    confidence_class: options.confidenceClass ?? 'proven',
    freshness_status: options.freshness ?? 'fresh',
    dirty_dependency_count: 0,
    updated_at: 1,
  });
}

function ids(): string[] {
  return ['A', 'B', 'C', 'D', 'E', 'F'];
}

function edgeSummary(result: ReturnType<typeof traverseFrom>): string[] {
  return result.edges.map(
    (edge) => `${edge.source_node_id}->${edge.target_node_id}:${edge.edge_type}:${edge.traversed}`
  );
}

describe('direction and canonical edge contract', () => {
  it('defaults to outgoing and preserves the existing trace filters', () => {
    expect(DEFAULT_TRAVERSAL_OPTIONS).toMatchObject({
      direction: 'outgoing',
      maxDepth: 8,
      maxNodes: 2000,
      maxFanout: 64,
      edgeTypes: ['calls', 'references'],
      minConfidenceClass: 'framework-inferred',
      includeExternal: true,
    });
  });

  it('walks outgoing edges forward without rewriting stored endpoints', () => {
    addNode('A');
    addNode('B');
    addEdge('A', 'B');

    const result = traverseFrom(db, 'A');

    expect(result.nodes.map((node) => node.id)).toEqual(['A', 'B']);
    expect(edgeSummary(result)).toEqual(['A->B:calls:forward']);
    expect(adjacentNode(result.edges[0])).toBe('B');
  });

  it('walks incoming edges reverse while retaining canonical source and target', () => {
    addNode('caller');
    addNode('handler');
    addEdge('caller', 'handler', { edgeType: 'handled_by' });

    const result = traverseFrom(db, 'handler', {
      direction: 'incoming',
      edgeTypes: ['handled_by'],
    });

    expect(result.nodes.map((node) => node.id)).toEqual(['handler', 'caller']);
    expect(result.edges[0]).toMatchObject({
      source_node_id: 'caller',
      target_node_id: 'handler',
      traversed: 'reverse',
    });
    expect(adjacentNode(result.edges[0])).toBe('caller');
  });

  it('walks both directions through one breadth-first frontier', () => {
    ids()
      .slice(0, 3)
      .forEach((id) => addNode(id));
    addEdge('A', 'B');
    addEdge('B', 'C');

    const result = traverseFrom(db, 'B', { direction: 'both', maxDepth: 1 });

    expect(result.nodes.map((node) => [node.id, node.depth])).toEqual([
      ['B', 0],
      ['A', 1],
      ['C', 1],
    ]);
    expect(edgeSummary(result)).toEqual(['A->B:calls:reverse', 'B->C:calls:forward']);
  });

  it('keys one stored self-loop independently in forward and reverse directions', () => {
    addNode('A');
    addEdge('A', 'A', { id: 'self' });

    const adjacent = edgesFor(db, 'A', 'both');
    expect(adjacent.map((edge) => edge.traversed)).toEqual(['forward', 'reverse']);
    expect(new Set(adjacent.map(traversalKey)).size).toBe(2);

    const result = traverseFrom(db, 'A', { direction: 'both' });
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(2);
    expect(result.edges.every((edge) => edge.revisit)).toBe(true);
  });
});

describe('one global budget and cycle safety', () => {
  it('admits every node once in a bidirectional cycle', () => {
    ids()
      .slice(0, 3)
      .forEach((id) => addNode(id));
    addEdge('A', 'B');
    addEdge('B', 'C');
    addEdge('C', 'A');

    const result = traverseFrom(db, 'A', { direction: 'both' });

    expect(result.nodes.map((node) => node.id).sort()).toEqual(['A', 'B', 'C']);
    expect(new Set(result.nodes.map((node) => node.id)).size).toBe(3);
    expect(result.edges.some((edge) => edge.revisit)).toBe(true);
  });

  it('shares maxDepth across both directions', () => {
    ids()
      .slice(0, 5)
      .forEach((id) => addNode(id));
    addEdge('A', 'B');
    addEdge('B', 'C');
    addEdge('C', 'D');
    addEdge('D', 'E');

    const result = traverseFrom(db, 'C', { direction: 'both', maxDepth: 1 });

    expect(result.nodes.map((node) => node.id)).toEqual(['C', 'B', 'D']);
    expect(result.nodes.filter((node) => node.terminus === 'depth-limit')).toHaveLength(2);
    expect(result.stats.maxDepthReached).toBe(1);
    expect(result.stats.truncated).toBe(true);
  });

  it('shares maxNodes across incoming and outgoing admission without overshoot', () => {
    ids()
      .slice(0, 5)
      .forEach((id) => addNode(id));
    addEdge('A', 'C', { id: '1' });
    addEdge('B', 'C', { id: '2' });
    addEdge('C', 'D', { id: '3' });
    addEdge('C', 'E', { id: '4' });

    const result = traverseFrom(db, 'C', {
      direction: 'both',
      maxNodes: 3,
      maxFanout: 10,
    });

    expect(result.stats.nodeCount).toBe(3);
    expect(result.nodes.map((node) => node.id)).toEqual(['C', 'A', 'B']);
    expect(result.nodes.find((node) => node.id === 'C')?.terminus).toBe('node-budget');
    expect(result.stats.truncated).toBe(true);
  });

  it('applies one combined fanout cap, not one cap per direction', () => {
    ids()
      .slice(0, 5)
      .forEach((id) => addNode(id));
    addEdge('A', 'C', { id: 'a' });
    addEdge('B', 'C', { id: 'b' });
    addEdge('C', 'D', { id: 'c' });
    addEdge('C', 'E', { id: 'd' });

    const result = traverseFrom(db, 'C', {
      direction: 'both',
      maxFanout: 2,
      maxDepth: 1,
    });

    expect(result.edges).toHaveLength(2);
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes[0].terminus).toBe('fanout-cap');
  });
});

describe('filters, freshness, and external semantics', () => {
  it('applies edge type and confidence filters in either direction', () => {
    ids()
      .slice(0, 4)
      .forEach((id) => addNode(id));
    addEdge('A', 'C', { edgeType: 'calls', confidenceClass: 'heuristic' });
    addEdge('B', 'C', { edgeType: 'references', confidenceClass: 'proven' });
    addEdge('C', 'D', { edgeType: 'calls', confidenceClass: 'proven' });

    const strict = traverseFrom(db, 'C', {
      direction: 'both',
      edgeTypes: ['calls'],
      minConfidenceClass: 'framework-inferred',
      maxDepth: 1,
    });
    expect(edgeSummary(strict)).toEqual(['C->D:calls:forward']);

    const loose = traverseFrom(db, 'C', {
      direction: 'both',
      edgeTypes: ['calls'],
      minConfidenceClass: 'heuristic',
      maxDepth: 1,
    });
    expect(edgeSummary(loose)).toEqual(['A->C:calls:reverse', 'C->D:calls:forward']);
  });

  it('includes stale edges but exposes their canonical freshness', () => {
    addNode('A');
    addNode('B');
    addNode('C');
    addEdge('A', 'B', { freshness: 'stale' });
    addEdge('B', 'C', { freshness: 'dirty-dependent' });

    const result = traverseFrom(db, 'A');

    expect(result.nodes.map((node) => node.id)).toEqual(['A', 'B', 'C']);
    expect(result.edges.map((edge) => edge.freshness_status)).toEqual(['stale', 'dirty-dependent']);
    expect(result.stats.freshness).toEqual({
      fresh: 0,
      stale: 1,
      dirtyDependent: 1,
      unknown: 0,
    });
  });

  it('filters an external adjacent node consistently in reverse traversal', () => {
    addNode('vendor', { origin: 'vendor-pack' });
    addNode('local');
    addEdge('vendor', 'local');

    const excluded = traverseFrom(db, 'local', {
      direction: 'incoming',
      includeExternal: false,
    });
    expect(excluded.nodes.map((node) => node.id)).toEqual(['local']);
    expect(excluded.edges).toHaveLength(0);

    const included = traverseFrom(db, 'local', {
      direction: 'incoming',
      includeExternal: true,
    });
    expect(included.nodes.find((node) => node.id === 'vendor')?.external).toBe(true);
    expect(included.stats.externalCount).toBe(1);
  });
});

describe('dispatch direction', () => {
  it('stops canonical forward traversal at a dispatch edge', () => {
    addNode('publisher');
    addNode('event');
    addNode('listener');
    addEdge('publisher', 'event', { edgeType: 'emits_event' });
    addEdge('event', 'listener');

    const result = traverseFrom(db, 'publisher', {
      edgeTypes: ['emits_event', 'calls'],
    });

    expect(result.nodes.map((node) => node.id)).toEqual(['publisher', 'event']);
    expect(result.nodes[1].terminus).toBe('dynamic-dispatch-boundary');
    expect(result.edges[0].dispatch).toMatchObject({
      traversed: 'forward',
      boundary: true,
      dispatchKind: 'event',
    });
  });

  it('annotates a reverse dispatch edge without treating the caller as forward re-entry', () => {
    addNode('publisher');
    addNode('event');
    addNode('upstream');
    addEdge('publisher', 'event', { edgeType: 'emits_event' });
    addEdge('upstream', 'publisher');

    const result = traverseFrom(db, 'event', {
      direction: 'incoming',
      edgeTypes: ['emits_event', 'calls'],
    });

    expect(result.nodes.map((node) => node.id)).toEqual(['event', 'publisher', 'upstream']);
    expect(result.nodes.find((node) => node.id === 'publisher')?.terminus).not.toBe(
      'dynamic-dispatch-boundary'
    );
    expect(result.edges[0].dispatch).toMatchObject({
      traversed: 'reverse',
      boundary: false,
      dispatchKind: 'event',
    });
    expect(result.stats.dispatchBoundaries).toBe(0);
  });

  it('lets incoming traversal query callers of catalogued dispatch machinery', () => {
    addNode('caller');
    addNode('dispatcher', {
      origin: 'vendor-pack',
      qualifiedName: 'Illuminate\\Events\\Dispatcher::dispatch',
    });
    addEdge('caller', 'dispatcher');

    const incoming = traverseFrom(db, 'dispatcher', { direction: 'incoming' });
    expect(incoming.nodes.map((node) => node.id)).toEqual(['dispatcher', 'caller']);
    expect(incoming.nodes[0].terminus).not.toBe('dynamic-dispatch-boundary');

    const outgoing = traverseFrom(db, 'dispatcher');
    expect(outgoing.nodes).toHaveLength(1);
    expect(outgoing.nodes[0].terminus).toBe('dynamic-dispatch-boundary');
  });
});

describe('option validation', () => {
  it.each([
    [{ maxDepth: -1 }, 'maxDepth'],
    [{ maxNodes: 0 }, 'maxNodes'],
    [{ maxFanout: -1 }, 'maxFanout'],
  ] as const)('rejects an invalid bounded option %#', (options, field) => {
    addNode('A');
    expect(() => traverseFrom(db, 'A', options)).toThrow(field);
  });
});
