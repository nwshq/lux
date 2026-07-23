// Lever D — the shared per-rebuild extraction cache. Verifies the cache is built
// once per eligible file and that the downstream consumers (materializer,
// structural resolver) read from it instead of re-parsing. The consumer tests
// feed a CRAFTED extraction that the real source could never produce, so a pass
// proves the cache was consumed rather than the file re-parsed.

import { describe, it, expect } from 'vitest';
import type { LuxDatabase } from '../../../db/index.js';
import type { StructuralNode } from '../../../db/types.js';
import type { ScanResult } from '../../types.js';
import type { AssociationContext } from '../../associations/types.js';
import type { AstNode, AstEdge, Extraction } from '../extract.js';
import { buildSharedExtractions, type SharedExtractions } from '../extraction-cache.js';
import { materializeAstSymbols } from '../materialize.js';
import { AstStructuralResolver } from '../resolver.js';

function mockDb(sink: StructuralNode[]): LuxDatabase {
  return {
    upsertStructuralNode: (n: StructuralNode) => sink.push(n),
    // materializeAstSymbols also upserts anchor texts (mig 014) in the same transaction — no-op here.
    upsertNodeAnchorText: () => {},
    transaction: <T>(fn: () => T): T => fn(),
  } as unknown as LuxDatabase;
}

function node(name: string, startByte: number, endByte: number): AstNode {
  return {
    type: 'function',
    name,
    file: 'x.ts',
    range: {
      startLine: 1,
      startColumn: 0,
      endLine: 1,
      endColumn: 1,
      startByte,
      endByte,
    },
  };
}

describe('buildSharedExtractions', () => {
  it('yields one entry per AST-eligible file and skips the rest', async () => {
    const scan: ScanResult = {
      knowledge: [
        {
          type: 'source-code',
          title: 'a.ts',
          filePath: '/repo/a.ts',
          frontmatter: { language: 'typescript' },
          content: 'export function foo() {}',
        },
        {
          type: 'source-code',
          title: 'Ledger.php',
          filePath: '/repo/Ledger.php',
          frontmatter: { language: 'php' },
          content: '<?php\nnamespace App;\nclass Ledger {}',
        },
        {
          type: 'source-code',
          title: 'notes.md',
          filePath: '/repo/notes.md',
          frontmatter: {},
          content: '# not code',
        },
        {
          type: 'source-code',
          title: 'empty.ts',
          filePath: '/repo/empty.ts',
          frontmatter: { language: 'typescript' },
          content: '', // no content → skipped
        },
      ],
    };

    const cache = await buildSharedExtractions(scan, '/repo');

    expect([...cache.keys()].sort()).toEqual(['Ledger.php', 'a.ts']);
    expect(cache.get('a.ts')?.nodes.some((n) => n.name === 'foo')).toBe(true);
    expect(cache.get('Ledger.php')?.nodes.some((n) => n.name === 'Ledger')).toBe(true);
  });
});

describe('shared extractions are consumed (not re-parsed)', () => {
  it('materializeAstSymbols reads symbol identity from the cache', async () => {
    const cache: SharedExtractions = new Map([
      ['a.ts', { nodes: [node('FROM_CACHE', 0, 100)], edges: [] } satisfies Extraction],
    ]);
    const scan: ScanResult = {
      knowledge: [
        {
          type: 'source-code',
          title: 'a.ts',
          filePath: '/repo/a.ts',
          frontmatter: { language: 'typescript' },
          content: 'export function real() {}', // would produce `real` if re-parsed
        },
      ],
    };

    const sink: StructuralNode[] = [];
    const count = await materializeAstSymbols(mockDb(sink), scan, '/repo', 1000, cache);

    const ids = sink.map((n) => n.id);
    expect(ids).toContain('symbol:ts:a.ts#FROM_CACHE');
    expect(ids).not.toContain('symbol:ts:a.ts#real');
    expect(count).toBe(1);
  });

  it('AstStructuralResolver reads edges from the cache', async () => {
    const call: AstEdge = {
      type: 'call',
      fromFile: 'x.ts',
      toRaw: 'b',
      member: 'b',
      callKind: 'identifier',
      resolvedSameFile: true,
      range: { startLine: 2, startColumn: 2, endLine: 2, endColumn: 5, startByte: 10, endByte: 13 },
    };
    const extraction: Extraction = {
      nodes: [node('a', 0, 100), node('b', 200, 300)],
      edges: [call],
    };
    const context: AssociationContext = {
      rootPath: '/repo',
      nodes: [],
      // Empty content — re-parsing would produce NOTHING; only the cache has edges.
      entries: [{ filePath: '/repo/x.ts', metadata: { content: '' } }],
      dirtyFiles: [],
      sharedExtractions: new Map([['x.ts', extraction]]),
    };

    const edges = await new AstStructuralResolver().resolve(context);
    const callEdge = edges.find((e) => e.edgeType === 'calls');
    expect(callEdge?.sourceNodeId).toBe('symbol:ts:x.ts#a');
    expect(callEdge?.targetNodeId).toBe('symbol:ts:x.ts#b');
  });
});
