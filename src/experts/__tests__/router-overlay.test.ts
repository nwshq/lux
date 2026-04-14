// Tests for structural overlay integration in the expert router.
// Covers: getStructuralContextForFile, enrichHitsWithOverlay, and
// buildAugmentedQuery with overlayContext populated.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../db/index.js';
import { getStructuralContextForFile, enrichHitsWithOverlay, buildAugmentedQuery } from '../router.js';
import type { FtsHit } from '../router.js';
import type { StructuralNode, StructuralEdge } from '../../db/types.js';

const testDir = join(import.meta.dirname, 'fixtures', 'router-overlay-test');
const ROOT = '/project';

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, 'test.db'));
}

function fileNode(relPath: string): StructuralNode {
  return {
    id: `file:${relPath}`,
    node_type: 'file',
    file_path: relPath,
    language_id: 'typescript',
    updated_at: Math.floor(Date.now() / 1000),
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  edgeType = 'calls_endpoint'
): StructuralEdge {
  return {
    id,
    source_node_id: source,
    target_node_id: target,
    edge_type: edgeType,
    confidence: 0.9,
    confidence_class: 'framework-inferred',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: Math.floor(Date.now() / 1000),
  };
}

describe('getStructuralContextForFile', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return null when the file has no structural node', () => {
    const result = getStructuralContextForFile(db, join(ROOT, 'src/app.ts'), ROOT);
    expect(result).toBeNull();
  });

  it('should return null when the node exists but has no edges', () => {
    db.upsertStructuralNode(fileNode('src/app.ts'));
    const result = getStructuralContextForFile(db, join(ROOT, 'src/app.ts'), ROOT);
    expect(result).toBeNull();
  });

  it('should return a formatted block when edges exist', () => {
    db.upsertStructuralNode(fileNode('src/app.ts'));
    db.upsertStructuralNode(fileNode('src/api.ts'));
    db.upsertStructuralEdge(edge('e1', 'file:src/app.ts', 'file:src/api.ts'));

    const result = getStructuralContextForFile(db, join(ROOT, 'src/app.ts'), ROOT);
    expect(result).not.toBeNull();
    expect(result).toContain('file:src/app.ts');
    expect(result).toContain('calls_endpoint');
  });

  it('should handle files under nested paths correctly', () => {
    db.upsertStructuralNode(fileNode('app/Services/InvoiceService.ts'));
    db.upsertStructuralNode(fileNode('app/Http/Controllers/InvoiceController.ts'));
    db.upsertStructuralEdge(
      edge(
        'e2',
        'file:app/Services/InvoiceService.ts',
        'file:app/Http/Controllers/InvoiceController.ts',
        'implements_interface'
      )
    );

    const result = getStructuralContextForFile(
      db,
      join(ROOT, 'app/Services/InvoiceService.ts'),
      ROOT
    );
    expect(result).not.toBeNull();
    expect(result).toContain('implements_interface');
  });

  it('should return null on file paths not under rootPath', () => {
    // File path that doesn't start with ROOT
    const result = getStructuralContextForFile(db, '/other/path/file.ts', ROOT);
    expect(result).toBeNull();
  });

  it('should include both outgoing and incoming edges in the context block', () => {
    db.upsertStructuralNode(fileNode('src/a.ts'));
    db.upsertStructuralNode(fileNode('src/b.ts'));
    db.upsertStructuralNode(fileNode('src/c.ts'));
    db.upsertStructuralEdge(edge('ea', 'file:src/a.ts', 'file:src/b.ts'));
    db.upsertStructuralEdge(edge('eb', 'file:src/c.ts', 'file:src/a.ts'));

    const result = getStructuralContextForFile(db, join(ROOT, 'src/a.ts'), ROOT);
    expect(result).not.toBeNull();
    // Should reference both edges (outgoing to b, incoming from c)
    expect(result).toContain('file:src/b.ts');
    expect(result).toContain('file:src/c.ts');
  });
});

describe('enrichHitsWithOverlay', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should mutate hits in-place, adding overlayContext where edges exist', () => {
    db.upsertStructuralNode(fileNode('src/app.ts'));
    db.upsertStructuralNode(fileNode('src/api.ts'));
    db.upsertStructuralEdge(edge('e1', 'file:src/app.ts', 'file:src/api.ts'));

    const hits: FtsHit[] = [
      { filePath: join(ROOT, 'src/app.ts'), rank: 0, content: 'code' },
      { filePath: join(ROOT, 'src/other.ts'), rank: 1, content: 'other' },
    ];

    enrichHitsWithOverlay(hits, db, ROOT);

    expect(hits[0].overlayContext).toBeDefined();
    expect(hits[0].overlayContext).toContain('file:src/app.ts');
    // second hit has no edges — overlayContext should remain undefined
    expect(hits[1].overlayContext).toBeUndefined();
  });

  it('should leave hits unchanged when no nodes exist in DB', () => {
    const hits: FtsHit[] = [
      { filePath: join(ROOT, 'src/app.ts'), rank: 0, content: 'code' },
    ];

    enrichHitsWithOverlay(hits, db, ROOT);

    expect(hits[0].overlayContext).toBeUndefined();
  });

  it('should handle an empty hits array without error', () => {
    expect(() => enrichHitsWithOverlay([], db, ROOT)).not.toThrow();
  });
});

describe('buildAugmentedQuery with overlayContext', () => {
  it('should include overlayContext in the augmented query when present', () => {
    const hits: FtsHit[] = [
      {
        filePath: '/project/src/app.ts',
        rank: 0,
        content: 'export class App {}',
        title: 'src/app.ts',
        overlayContext: 'Structural relations for file:src/app.ts:\n\n→ file:src/api.ts\n[calls_endpoint]',
      },
    ];

    const result = buildAugmentedQuery('What does App do?', hits);

    expect(result).toContain('Structural Relations');
    expect(result).toContain('calls_endpoint');
    expect(result).toContain('What does App do?');
  });

  it('should place overlay context before file content in each hit section', () => {
    const hits: FtsHit[] = [
      {
        filePath: '/project/src/app.ts',
        rank: 0,
        content: 'export class App {}',
        overlayContext: 'OVERLAY_MARKER',
      },
    ];

    const result = buildAugmentedQuery('Q?', hits);

    const overlayPos = result.indexOf('OVERLAY_MARKER');
    const contentPos = result.indexOf('export class App');
    expect(overlayPos).toBeGreaterThan(-1);
    expect(contentPos).toBeGreaterThan(-1);
    expect(overlayPos).toBeLessThan(contentPos);
  });

  it('should not add overlay section when overlayContext is absent', () => {
    const hits: FtsHit[] = [
      { filePath: '/project/src/app.ts', rank: 0, content: 'export class App {}' },
    ];

    const result = buildAugmentedQuery('Q?', hits);

    expect(result).not.toContain('Structural Relations');
  });
});
