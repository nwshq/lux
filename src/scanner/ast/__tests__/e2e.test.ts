import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import { AssociationEngine } from '../../associations/engine.js';
import type { AssociationContext } from '../../associations/types.js';
import type { ScanResult } from '../../types.js';
import { materializeAstSymbols } from '../materialize.js';
import { AstStructuralResolver } from '../resolver.js';

describe('AST tier end-to-end (materialize + resolve + persist)', () => {
  let dir: string;
  let db: LuxDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-ast-e2e-'));
    db = new LuxDatabase(join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('materializes AST symbols and persists a same-file calls edge to the DB', async () => {
    const content = [
      'export function doThing() {}',
      'class Widget {',
      '  render() {',
      '    doThing();',
      '  }',
      '}',
    ].join('\n');
    const scan: ScanResult = {
      knowledge: [
        {
          type: 'source-code',
          title: 'a.ts',
          filePath: '/repo/a.ts',
          frontmatter: { language: 'typescript' },
          content,
        },
      ],
    };

    // 1. Materialize AST symbol nodes (so the resolver's edges reference real nodes).
    const symbols = await materializeAstSymbols(db, scan, '/repo', 1000);
    expect(symbols).toBeGreaterThan(0);
    expect(db.getStructuralNode('symbol:ts:a.ts#doThing')).not.toBeNull();
    expect(db.getStructuralNode('symbol:ts:a.ts#Widget.render')).not.toBeNull();

    // 2. Run the AST resolver through the real association engine (persists edges).
    const context: AssociationContext = {
      rootPath: '/repo',
      nodes: [],
      entries: [{ filePath: '/repo/a.ts', metadata: { content } }],
      dirtyFiles: [],
    };
    await new AssociationEngine(db, [new AstStructuralResolver()], {}).rebuild(context);

    // 3. The calls edge survived the engine and is queryable from the caller node.
    const edges = db.getStructuralEdgesForNode('symbol:ts:a.ts#Widget.render');
    const call = edges.find((e) => e.edge_type === 'calls');
    expect(call).toBeDefined();
    expect(call?.target_node_id).toBe('symbol:ts:a.ts#doThing');
    expect(call?.confidence_class).toBe('framework-inferred');
  });
});
