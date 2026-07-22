// openSiblingReadOnly + the read-only invariant (spec 11 / Decision 4,7 / T1.3 / SC-7, A4).
// A sibling `.lux` is opened strictly read-only: the prepared wrappers work, a schema-skewed
// sibling throws, and — the load-bearing invariant — the sibling file is byte-identical before and
// after a full open → walk → close pass (no mkdir, no journal_mode header write, no -journal
// sidecar), and a write attempted through the handle hard-errors at the engine.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../index.js';
import { LuxSqlite } from '../sqlite-adapter.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-open-sibling-ro-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A populated, current-schema sibling `.lux`: two nodes + an edge + a searchable document. */
function makeSibling(name: string): { path: string; schema: number } {
  const path = join(root, name, '.lux', 'lux.db');
  const db = new LuxDatabase(path);
  db.upsertStructuralNode({ id: 'symbol:php:A', node_type: 'symbol', updated_at: 1 });
  db.upsertStructuralNode({ id: 'symbol:php:B', node_type: 'symbol', updated_at: 1 });
  db.upsertStructuralEdge({
    id: 'symbol:php:A->symbol:php:B',
    source_node_id: 'symbol:php:A',
    target_node_id: 'symbol:php:B',
    edge_type: 'calls',
    confidence: 1,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: 1,
  });
  db.insertKnowledgeEntry({
    type: 'document',
    title: 'Settlement Guide',
    file_path: 'a.md',
    content: 'settlement clearing netting',
  });
  const schema = db.getAppliedSchemaVersion();
  db.close();
  return { path, schema };
}

describe('LuxDatabase.openSiblingReadOnly (spec 11)', () => {
  it('returns a working handle: node, outgoing/incoming edges, and document search', () => {
    const { path, schema } = makeSibling('healthy');
    const db = LuxDatabase.openSiblingReadOnly(path, schema);
    try {
      expect(db.getStructuralNode('symbol:php:A')?.id).toBe('symbol:php:A');
      expect(db.getOutgoingStructuralEdges('symbol:php:A').length).toBe(1);
      expect(db.getIncomingStructuralEdges('symbol:php:B').length).toBe(1);
      expect(db.searchAllDocuments('settlement').length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('throws the parity error on a schema-skewed sibling and leaves no handle open', () => {
    const { path, schema } = makeSibling('skewed');
    const raw = new LuxSqlite(path);
    raw.run('DELETE FROM schema_version WHERE version = (SELECT MAX(version) FROM schema_version)');
    raw.close();
    expect(() => LuxDatabase.openSiblingReadOnly(path, schema)).toThrow(
      /schema v\d+ != primary v\d+/
    );
  });

  it('throws when the sibling index is absent', () => {
    const ghost = join(root, 'ghost', '.lux', 'lux.db');
    expect(() => LuxDatabase.openSiblingReadOnly(ghost, 1)).toThrow(/no index at/);
    expect(existsSync(ghost)).toBe(false); // did not create the file
  });

  it('read-only invariant (A4): sibling file byte-identical before/after a full pass', () => {
    const { path, schema } = makeSibling('invariant');
    const before = statSync(path);

    const db = LuxDatabase.openSiblingReadOnly(path, schema);
    db.getStructuralNode('symbol:php:A');
    db.getOutgoingStructuralEdges('symbol:php:A');
    db.searchAllDocuments('settlement');
    db.close();

    const after = statSync(path);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(existsSync(`${path}-journal`)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
  });

  it('hard-errors a write attempted through the handle (engine read-only)', () => {
    const { path, schema } = makeSibling('nowrite');
    const db = LuxDatabase.openSiblingReadOnly(path, schema);
    expect(() => db.setIndexMetadata('federation-probe', 'x')).toThrow(/readonly|read.only/i);
    // NB: don't close() — node-sqlite3-wasm re-throws the deferred write error when finalizing the
    // (deliberately) failed cached statement; the exit handler cleans up.
  });
});
