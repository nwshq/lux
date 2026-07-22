// siblingNodeIntersection — the in-engine seed filter before any cross-repo walk (spec 14 Part A /
// T3.1 / Decision 9 / SC-6). Returns exactly the seeds present as nodes OR edge targets in the
// index it is called on, deduped across the >500 IN-chunk boundary. It is designed to run on an
// openSiblingReadOnly handle (a pure SELECT), so the sibling `.lux` is byte-identical after the
// call. (It runs on the sibling's own read-only connection rather than ATTACHing onto the primary,
// to avoid the node-sqlite3-wasm DETACH deadlock a prior primary-side write triggers — see the
// method doc-comment; alias-safety of attachSibling is covered by attach-sibling.test.ts.)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../index.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-sib-intersect-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A populated, current-schema sibling `.lux`; returns its path + schema version. */
function makeSibling(
  name: string,
  build: (db: LuxDatabase) => void
): { path: string; schema: number } {
  const path = join(root, name, '.lux', 'lux.db');
  const db = new LuxDatabase(path);
  build(db);
  const schema = db.getAppliedSchemaVersion();
  db.close();
  return { path, schema };
}

describe('LuxDatabase.siblingNodeIntersection (spec 14 Part A)', () => {
  it('returns exactly the seeds present as nodes or edge targets, deduped across a >500 chunk boundary', () => {
    // 10 seeds present as nodes (S0..S9); S500 present ONLY as an edge target (in the 2nd IN-chunk,
    // proving the edges arm survives the >500 boundary); S5 present as BOTH node and edge target
    // (must dedup to one). SRC is the edge source; ABSENT is an edge target that is not a seed.
    const { path, schema } = makeSibling('sibling', (sibling) => {
      for (let i = 0; i < 10; i++) {
        sibling.upsertStructuralNode({
          id: `symbol:php:S${i}`,
          node_type: 'symbol',
          updated_at: 1,
        });
      }
      sibling.upsertStructuralNode({ id: 'symbol:php:SRC', node_type: 'symbol', updated_at: 1 });
      const edge = (target: string, n: number): void =>
        sibling.upsertStructuralEdge({
          id: `edge:${n}`,
          source_node_id: 'symbol:php:SRC',
          target_node_id: target,
          edge_type: 'calls',
          confidence: 1,
          confidence_class: 'proven',
          freshness_status: 'fresh',
          dirty_dependency_count: 0,
          updated_at: 1,
        });
      edge('symbol:php:S500', 1); // edge-target-only match, sits in the second chunk
      edge('symbol:php:S5', 2); // also a node → the UNION must dedup it
      edge('symbol:php:ABSENT', 3); // target not in the seed set → never returned
    });

    // 600 seeds → two IN-chunks (500 + 100). S599 is a seed that exists in neither table.
    const seeds = Array.from({ length: 600 }, (_, i) => `symbol:php:S${i}`);
    const sibDb = LuxDatabase.openSiblingReadOnly(path, schema);
    const matched = sibDb.siblingNodeIntersection(seeds);
    sibDb.close();

    const expected = [
      'symbol:php:S0',
      'symbol:php:S1',
      'symbol:php:S2',
      'symbol:php:S3',
      'symbol:php:S4',
      'symbol:php:S5',
      'symbol:php:S6',
      'symbol:php:S7',
      'symbol:php:S8',
      'symbol:php:S9',
      'symbol:php:S500',
    ];
    expect([...matched].sort()).toEqual([...expected].sort());
    expect(matched.length).toBe(new Set(matched).size); // no duplicates (S5 counted once)
    expect(matched).not.toContain('symbol:php:S599'); // seed present in neither table
    expect(matched).not.toContain('symbol:php:ABSENT'); // edge target that is not a seed
  });

  it('returns [] for an empty seed set', () => {
    const { path, schema } = makeSibling('s2', () => {});
    const sibDb = LuxDatabase.openSiblingReadOnly(path, schema);
    expect(sibDb.siblingNodeIntersection([])).toEqual([]);
    sibDb.close();
  });

  it('leaves the sibling `.lux` byte-identical after the intersection (read-only)', () => {
    const { path, schema } = makeSibling('s3', (db) =>
      db.upsertStructuralNode({ id: 'symbol:php:X', node_type: 'symbol', updated_at: 1 })
    );
    const before = statSync(path);

    const sibDb = LuxDatabase.openSiblingReadOnly(path, schema);
    sibDb.siblingNodeIntersection(['symbol:php:X', 'symbol:php:Y']);
    sibDb.close();

    const after = statSync(path);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(existsSync(`${path}-journal`)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
  });
});
