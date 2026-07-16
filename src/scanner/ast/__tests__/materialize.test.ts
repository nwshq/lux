import { describe, it, expect } from 'vitest';
import type { LuxDatabase } from '../../../db/index.js';
import type { StructuralNode } from '../../../db/types.js';
import type { ScanResult } from '../../types.js';
import { materializeAstSymbols } from '../materialize.js';

function mockDb(sink: StructuralNode[]): LuxDatabase {
  return {
    upsertStructuralNode: (n: StructuralNode) => sink.push(n),
    // materializeAstSymbols batches upserts in a transaction (Lever E).
    transaction: <T>(fn: () => T): T => fn(),
  } as unknown as LuxDatabase;
}

describe('materializeAstSymbols', () => {
  it('persists AST symbol nodes for supported source files and skips others', async () => {
    const scan: ScanResult = {
      knowledge: [
        {
          type: 'source-code',
          title: 'a.ts',
          filePath: '/repo/a.ts',
          frontmatter: { language: 'typescript' },
          content: 'export function foo() {}\nclass Bar {}',
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
          title: 'r.md',
          filePath: '/repo/r.md',
          frontmatter: {},
          content: '# not code',
        },
      ],
    };

    const sink: StructuralNode[] = [];
    const count = await materializeAstSymbols(mockDb(sink), scan, '/repo', 1000);

    const ids = sink.map((n) => n.id);
    expect(ids).toContain('symbol:ts:a.ts#foo');
    expect(ids).toContain('symbol:ts:a.ts#Bar');
    expect(ids).toContain('symbol:php:App\\Ledger');
    expect(ids.some((id) => id.includes('r.md'))).toBe(false); // unsupported lang skipped
    expect(count).toBe(sink.length);
    expect(sink.every((n) => n.node_type === 'symbol')).toBe(true);
  });

  it('returns 0 when there are no supported source files', async () => {
    const scan: ScanResult = {
      knowledge: [
        {
          type: 'source-code',
          title: 'x.md',
          filePath: '/repo/x.md',
          frontmatter: {},
          content: '# x',
        },
      ],
    };
    const sink: StructuralNode[] = [];
    const count = await materializeAstSymbols(mockDb(sink), scan, '/repo', 1000);
    expect(count).toBe(0);
    expect(sink).toHaveLength(0);
  });
});
