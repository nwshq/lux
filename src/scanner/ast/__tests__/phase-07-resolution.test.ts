import { describe, expect, it } from 'vitest';
import type { AssociationContext } from '../../associations/types.js';
import { AstStructuralResolver } from '../resolver.js';

function context(files: Record<string, string>): AssociationContext {
  return {
    rootPath: '/repo',
    nodes: [],
    entries: Object.entries(files).map(([filePath, content]) => ({
      filePath: `/repo/${filePath}`,
      metadata: { content },
    })),
    dirtyFiles: [],
  };
}

describe('Phase 7 AST integration', () => {
  it('resolves default imports through the canonical export index', async () => {
    const edges = await new AstStructuralResolver().resolve(
      context({
        'src/caller.ts': "import build from './factory.js';\nfunction run(){ build(); }",
        'src/factory.ts': 'export default function build() {}',
      })
    );
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceNodeId: 'symbol:ts:src/caller.ts#run',
          targetNodeId: 'symbol:ts:src/factory.ts#build',
          edgeType: 'calls',
        }),
      ])
    );
  });

  it('resolves named exports through export-all barrels', async () => {
    const edges = await new AstStructuralResolver().resolve(
      context({
        'src/caller.ts': "import { helper } from './barrel/index.js';\nfunction run(){ helper(); }",
        'src/barrel/index.ts': "export * from './helper.js';",
        'src/barrel/helper.ts': 'export function helper() {}',
      })
    );
    expect(
      edges.some((edge) => edge.targetNodeId === 'symbol:ts:src/barrel/helper.ts#helper')
    ).toBe(true);
  });

  it('refuses conflicting direct exports and emits a stable diagnostic', async () => {
    const diagnostics: string[] = [];
    const edges = await new AstStructuralResolver({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    }).resolve(
      context({
        'src/caller.js': "import { value } from './mixed.js';\nfunction run(){ value(); }",
        'src/mixed.js':
          'function esmValue(){}\nfunction cjsValue(){}\nexport { esmValue as value };\nexports.value = cjsValue;',
      })
    );
    expect(edges.some((edge) => edge.sourceNodeId === 'symbol:ts:src/caller.js#run')).toBe(false);
    expect(diagnostics).toContain('export-conflict');
  });

  it('refuses barrel cycles and traversal without emitting an edge', async () => {
    const diagnostics: string[] = [];
    const edges = await new AstStructuralResolver({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    }).resolve(
      context({
        'src/caller.ts': [
          "import { helper } from './a.js';",
          "import { escape } from '../../outside.js';",
          'function run(){ helper(); escape(); }',
        ].join('\n'),
        'src/a.ts': "export * from './b.js';",
        'src/b.ts': "export * from './a.js';",
      })
    );
    expect(edges).toHaveLength(0);
    expect(diagnostics).toEqual(expect.arrayContaining(['barrel-cycle', 'module.missing']));
  });
});
