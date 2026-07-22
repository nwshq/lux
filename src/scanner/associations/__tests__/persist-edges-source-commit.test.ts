// persistEdges source_commit stamping (spec 13 Part B / SC-8).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LuxDatabase } from '../../../db/index.js';
import { AssociationEngine } from '../engine.js';
import type { StructuralRelationEdge } from '../types.js';

function relEdge(id: string, source: string, target: string): StructuralRelationEdge {
  return {
    id,
    edgeType: 'calls',
    sourceNodeId: source,
    targetNodeId: target,
    confidence: 0.9,
    confidenceClass: 'framework-inferred',
    provenance: {
      resolver: 'test',
      evidenceKind: 'test',
      evidenceLocations: [{ filePath: 'a.ts', line: 1 }],
      extractedAt: Math.floor(Date.now() / 1000),
    },
  };
}

describe('AssociationEngine.persistEdges source_commit (SC-8)', () => {
  let dir: string;
  let db: LuxDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-source-commit-'));
    db = new LuxDatabase(join(dir, 'lux.db'));
    db.upsertStructuralNode({ id: 's', node_type: 'symbol', file_path: 'a.ts', updated_at: 1 });
    db.upsertStructuralNode({ id: 't', node_type: 'symbol', file_path: 'a.ts', updated_at: 1 });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stamps source_commit when passed', () => {
    AssociationEngine.persistEdges(db, [relEdge('e1', 's', 't')], 'abc123');
    const stored = db.getStructuralEdgesForNode('s').find((e) => e.id === 'e1');
    expect(stored?.source_commit).toBe('abc123');
    expect(stored?.freshness_status).toBe('fresh');
  });

  it('leaves source_commit NULL when omitted (unchanged full-rebuild behavior)', () => {
    AssociationEngine.persistEdges(db, [relEdge('e2', 's', 't')]);
    const stored = db.getStructuralEdgesForNode('s').find((e) => e.id === 'e2');
    expect(stored?.source_commit ?? null).toBeNull();
  });
});
