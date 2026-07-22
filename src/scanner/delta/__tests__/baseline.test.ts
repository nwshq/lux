import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import { diffBaseline } from '../baseline.js';
import type { BaselineDiff } from '../types.js';
import type { StructuralEdge, StructuralNode } from '../../../db/types.js';

let root: string;
let corpus: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-delta-baseline-'));
  corpus = join(root, 'corpus');
  // Two module dirs under packages/ so detectModuleBoundaries → ['packages/{name}'] and the
  // node file paths below resolve to modA / modB (a real known-pattern boundary).
  mkdirSync(join(corpus, 'packages', 'modA'), { recursive: true });
  mkdirSync(join(corpus, 'packages', 'modB'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function now(): number {
  return Math.floor(Date.now() / 1000);
}
function node(id: string, over: Partial<StructuralNode> = {}): StructuralNode {
  return { id, node_type: 'symbol', updated_at: now(), ...over };
}
function edge(id: string, over: Partial<StructuralEdge> = {}): StructuralEdge {
  return {
    id,
    source_node_id: 'a',
    target_node_id: 'b',
    edge_type: 'calls',
    confidence: 0.9,
    confidence_class: 'framework-inferred',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: now(),
    ...over,
  };
}

function isDiff(v: BaselineDiff | { reason: string }): v is BaselineDiff {
  return 'surfacesRemoved' in v;
}

/** Build a `.lux`, run `populate`, close it, and return its path (a standalone baseline artifact). */
function makeBaselineDb(populate: (db: LuxDatabase) => void): string {
  const path = join(root, 'baseline', '.lux', 'lux.db');
  const db = new LuxDatabase(path);
  populate(db);
  db.close();
  return path;
}

describe('diffBaseline (spec 17 Part B)', () => {
  it('projects surfaces ± and deduped cross-module edges +, and refuses a missing baseline', () => {
    // Baseline (base ref) state: a surface that HEAD removes, plus an edge HEAD keeps.
    const baselinePath = makeBaselineDb((b) => {
      b.upsertStructuralNode(node('surface:http:GET:/gone', { node_type: 'capability-surface' }));
      b.upsertStructuralNode(node('sym:keptA', { file_path: 'packages/modA/Kept.php' }));
      b.upsertStructuralNode(node('sym:keptB', { file_path: 'packages/modB/Kept.php' }));
      b.upsertStructuralEdge(
        edge('edge:kept', { source_node_id: 'sym:keptA', target_node_id: 'sym:keptB' })
      );
    });

    // HEAD (primary) state.
    const headPath = join(root, 'head', '.lux', 'lux.db');
    const head = new LuxDatabase(headPath);
    // a surface only at HEAD → surfacesAdded
    head.upsertStructuralNode(node('surface:http:GET:/new', { node_type: 'capability-surface' }));
    // the edge kept from baseline (present in both → NOT new)
    head.upsertStructuralNode(node('sym:keptA', { file_path: 'packages/modA/Kept.php' }));
    head.upsertStructuralNode(node('sym:keptB', { file_path: 'packages/modB/Kept.php' }));
    head.upsertStructuralEdge(
      edge('edge:kept', { source_node_id: 'sym:keptA', target_node_id: 'sym:keptB' })
    );
    // two NEW cross-module edges modA→modB (calls) → one deduped crossModuleEdgesAdded entry
    head.upsertStructuralNode(node('sym:A1', { file_path: 'packages/modA/Foo.php' }));
    head.upsertStructuralNode(node('sym:A2', { file_path: 'packages/modA/Foo2.php' }));
    head.upsertStructuralNode(node('sym:B1', { file_path: 'packages/modB/Bar.php' }));
    head.upsertStructuralNode(node('sym:B2', { file_path: 'packages/modB/Bar2.php' }));
    head.upsertStructuralEdge(
      edge('edge:new1', { source_node_id: 'sym:A1', target_node_id: 'sym:B1' })
    );
    head.upsertStructuralEdge(
      edge('edge:new2', { source_node_id: 'sym:A2', target_node_id: 'sym:B2' })
    );
    // a NEW intra-module edge modA→modA → must NOT be reported as cross-module
    head.upsertStructuralNode(node('sym:A3', { file_path: 'packages/modA/Baz.php' }));
    head.upsertStructuralEdge(
      edge('edge:intra', { source_node_id: 'sym:A1', target_node_id: 'sym:A3' })
    );

    const result = diffBaseline(head, corpus, baselinePath);
    expect(isDiff(result)).toBe(true);
    if (!isDiff(result)) return;

    expect(result.surfacesRemoved).toEqual(['surface:http:GET:/gone']);
    expect(result.surfacesAdded).toEqual(['surface:http:GET:/new']);
    // deduped: the two modA→modB calls edges collapse to a single entry; intra-module is excluded.
    expect(result.crossModuleEdgesAdded).toEqual([
      { source: 'modA', target: 'modB', edgeType: 'calls' },
    ]);

    // a missing baseline path → structured baseline-unavailable refusal (Decision 15)
    const missing = diffBaseline(head, corpus, join(root, 'nope', 'lux.db'));
    expect(isDiff(missing)).toBe(false);
    if (!isDiff(missing)) {
      expect(missing.reason).toBe('baseline-unavailable');
    }

    head.close();
  });
});
