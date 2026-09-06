import { describe, expect, it } from 'vitest';
import type { AstNode, AstRange } from '../../ast/extract.js';
import type { ExportTargetV1, ModuleExportIndexV1 } from '../../contracts/program.js';
import { buildModuleExportIndexes, resolveExport, type FileExtractionV1 } from '../export-index.js';

const range: AstRange = {
  startLine: 1,
  startColumn: 0,
  endLine: 1,
  endColumn: 1,
  startByte: 0,
  endByte: 1,
};

function node(name: string, overrides: Partial<AstNode> = {}): AstNode {
  return { type: 'function', name, file: 'unused.ts', range, ...overrides };
}

function file(
  filePath: string,
  moduleFacts: NonNullable<FileExtractionV1['extraction']['moduleFacts']>,
  nodes: AstNode[] = []
): FileExtractionV1 {
  return {
    filePath,
    extraction: { nodes, edges: [], moduleFacts },
  };
}

function target(filePath: string, localName: string, declarationId?: string): ExportTargetV1 {
  return {
    filePath,
    localName,
    ...(declarationId ? { declarationId } : {}),
  };
}

function index(
  values: Partial<ModuleExportIndexV1> & Pick<ModuleExportIndexV1, 'named'>
): ModuleExportIndexV1 {
  return { reexports: [], ...values };
}

const modules: Record<string, string> = {
  './a': 'src/a.ts',
  './b': 'src/b.ts',
  './shared': 'src/shared.ts',
  './cycle-a': 'src/cycle-a.ts',
  './cycle-b': 'src/cycle-b.ts',
};

function resolveModule(_fromFile: string, specifier: string): string | undefined {
  return modules[specifier];
}

describe('buildModuleExportIndexes', () => {
  it('indexes ESM default, named, and re-export syntax with declaration identities', () => {
    const indexes = buildModuleExportIndexes([
      file(
        'src/module.ts',
        [
          { kind: 'esm-export-default', localName: 'Main' },
          { kind: 'esm-export-named', localName: 'helper', exportedName: 'renamed' },
          {
            kind: 'esm-reexport-named',
            localName: 'sourceName',
            importedName: 'sourceName',
            exportedName: 'publicName',
            specifier: './shared',
          },
          { kind: 'esm-reexport-all', exportedName: '*', importedName: '*', specifier: './a' },
        ],
        [node('Main'), node('helper')]
      ),
    ]);

    expect(indexes.get('src/module.ts')).toEqual({
      default: target('src/module.ts', 'Main', 'Main'),
      named: { renamed: target('src/module.ts', 'helper', 'helper') },
      reexports: [
        { exported: 'publicName', imported: 'sourceName', specifier: './shared' },
        { exported: '*', imported: '*', specifier: './a' },
      ],
    });
  });

  it('indexes CommonJS default and named exports', () => {
    const indexes = buildModuleExportIndexes([
      file(
        'src/module.cjs',
        [
          { kind: 'commonjs-module-exports', localName: 'Main', exportedName: 'default' },
          { kind: 'commonjs-exports-member', localName: 'helper', exportedName: 'run' },
        ],
        [node('Main'), node('helper')]
      ),
    ]);

    expect(indexes.get('src/module.cjs')).toEqual({
      default: target('src/module.cjs', 'Main', 'Main'),
      named: { run: target('src/module.cjs', 'helper', 'helper') },
      reexports: [],
    });
  });

  it('deduplicates identical ESM and CommonJS named exports in the direct slot', () => {
    const indexes = buildModuleExportIndexes([
      file(
        'src/mixed.js',
        [
          { kind: 'esm-export-named', localName: 'shared', exportedName: 'shared' },
          { kind: 'commonjs-exports-member', localName: 'shared', exportedName: 'shared' },
        ],
        [node('shared')]
      ),
    ]);

    expect(indexes.get('src/mixed.js')).toEqual({
      named: { shared: target('src/mixed.js', 'shared', 'shared') },
      reexports: [],
    });
  });

  it('moves differing ESM and CommonJS named exports into conflicts', () => {
    const indexes = buildModuleExportIndexes([
      file(
        'src/mixed.js',
        [
          { kind: 'esm-export-named', localName: 'esmValue', exportedName: 'value' },
          { kind: 'commonjs-exports-member', localName: 'cjsValue', exportedName: 'value' },
          { kind: 'commonjs-exports-member', localName: 'esmValue', exportedName: 'value' },
        ],
        [node('esmValue'), node('cjsValue')]
      ),
    ]);

    expect(indexes.get('src/mixed.js')).toEqual({
      named: {},
      reexports: [],
      conflicts: {
        value: [
          target('src/mixed.js', 'cjsValue', 'cjsValue'),
          target('src/mixed.js', 'esmValue', 'esmValue'),
        ],
      },
    });
  });

  it('moves differing ESM and CommonJS default exports into the default conflict key', () => {
    const indexes = buildModuleExportIndexes([
      file(
        'src/mixed.cjs',
        [
          { kind: 'esm-export-default', localName: 'EsmMain' },
          { kind: 'commonjs-module-exports', localName: 'CjsMain' },
        ],
        [node('EsmMain'), node('CjsMain')]
      ),
    ]);

    expect(indexes.get('src/mixed.cjs')).toEqual({
      named: {},
      reexports: [],
      conflicts: {
        default: [
          target('src/mixed.cjs', 'CjsMain', 'CjsMain'),
          target('src/mixed.cjs', 'EsmMain', 'EsmMain'),
        ],
      },
    });
  });

  it('preserves exported names that overlap object prototype properties', () => {
    const indexes = buildModuleExportIndexes([
      file('src/safe.js', [
        { kind: 'esm-export-named', localName: 'protoValue', exportedName: '__proto__' },
        { kind: 'esm-export-named', localName: 'constructorValue', exportedName: 'constructor' },
      ]),
    ]);

    expect(
      Object.prototype.hasOwnProperty.call(indexes.get('src/safe.js')?.named, '__proto__')
    ).toBe(true);
    expect(indexes.get('src/safe.js')?.named['__proto__']).toEqual(
      target('src/safe.js', 'protoValue')
    );
    expect(indexes.get('src/safe.js')?.named.constructor).toEqual(
      target('src/safe.js', 'constructorValue')
    );
  });
});

describe('resolveExport', () => {
  it('resolves direct default and named exports', () => {
    const indexes = new Map([
      [
        'src/direct.ts',
        index({
          default: target('src/direct.ts', 'Main', 'Main'),
          named: { helper: target('src/direct.ts', 'helper', 'helper') },
        }),
      ],
    ]);

    expect(resolveExport('src/direct.ts', 'default', indexes, resolveModule)).toEqual({
      status: 'resolved',
      target: target('src/direct.ts', 'Main', 'Main'),
    });
    expect(resolveExport('src/direct.ts', 'helper', indexes, resolveModule)).toEqual({
      status: 'resolved',
      target: target('src/direct.ts', 'helper', 'helper'),
    });
  });

  it('returns conflicting direct ESM and CommonJS candidates as ambiguous', () => {
    const indexes = buildModuleExportIndexes([
      file(
        'src/mixed.js',
        [
          { kind: 'esm-export-named', localName: 'esmValue', exportedName: 'value' },
          { kind: 'commonjs-exports-member', localName: 'cjsValue', exportedName: 'value' },
        ],
        [node('esmValue'), node('cjsValue')]
      ),
    ]);

    expect(resolveExport('src/mixed.js', 'value', indexes, resolveModule)).toEqual({
      status: 'ambiguous',
      candidates: [
        target('src/mixed.js', 'cjsValue', 'cjsValue'),
        target('src/mixed.js', 'esmValue', 'esmValue'),
      ],
    });
  });

  it('combines conflicts, a legacy direct slot, and re-exports before deduplication', () => {
    const shared = target('src/shared.ts', 'shared', 'shared');
    const indexes = new Map<string, ModuleExportIndexV1>([
      [
        'src/barrel.ts',
        index({
          named: { value: shared },
          conflicts: {
            value: [target('src/a.ts', 'a', 'a'), shared],
          },
          reexports: [{ exported: 'value', imported: 'value', specifier: './b' }],
        }),
      ],
      ['src/b.ts', index({ named: { value: target('src/b.ts', 'b', 'b') } })],
    ]);

    expect(resolveExport('src/barrel.ts', 'value', indexes, resolveModule)).toEqual({
      status: 'ambiguous',
      candidates: [target('src/a.ts', 'a', 'a'), target('src/b.ts', 'b', 'b'), shared],
    });
  });

  it('resolves named and export-all barrels recursively', () => {
    const leaf = target('src/shared.ts', 'internal', 'internal');
    const indexes = new Map<string, ModuleExportIndexV1>([
      [
        'src/a.ts',
        index({
          named: {},
          reexports: [{ exported: 'public', imported: 'internal', specifier: './shared' }],
        }),
      ],
      [
        'src/b.ts',
        index({
          named: {},
          reexports: [{ exported: '*', imported: '*', specifier: './a' }],
        }),
      ],
      ['src/shared.ts', index({ named: { internal: leaf } })],
    ]);

    expect(resolveExport('src/a.ts', 'public', indexes, resolveModule)).toEqual({
      status: 'resolved',
      target: leaf,
    });
    expect(resolveExport('src/b.ts', 'public', indexes, resolveModule)).toEqual({
      status: 'resolved',
      target: leaf,
    });
  });

  it('deduplicates the same target reached directly and through multiple barrels', () => {
    const shared = target('src/shared.ts', 'value', 'value');
    const indexes = new Map<string, ModuleExportIndexV1>([
      [
        'src/barrel.ts',
        index({
          named: { value: shared },
          reexports: [
            { exported: 'value', imported: 'value', specifier: './shared' },
            { exported: '*', imported: '*', specifier: './shared' },
          ],
        }),
      ],
      ['src/shared.ts', index({ named: { value: shared } })],
    ]);

    expect(resolveExport('src/barrel.ts', 'value', indexes, resolveModule)).toEqual({
      status: 'resolved',
      target: shared,
    });
  });

  it('returns multiple re-export targets as a deterministically sorted ambiguity', () => {
    const indexes = new Map<string, ModuleExportIndexV1>([
      [
        'src/barrel.ts',
        index({
          named: {},
          reexports: [
            { exported: '*', imported: '*', specifier: './b' },
            { exported: '*', imported: '*', specifier: './a' },
          ],
        }),
      ],
      ['src/a.ts', index({ named: { value: target('src/a.ts', 'z', 'z') } })],
      ['src/b.ts', index({ named: { value: target('src/b.ts', 'a', 'a') } })],
    ]);

    expect(resolveExport('src/barrel.ts', 'value', indexes, resolveModule)).toEqual({
      status: 'ambiguous',
      candidates: [target('src/a.ts', 'z', 'z'), target('src/b.ts', 'a', 'a')],
    });
  });

  it('does not forward default exports through export-all', () => {
    const indexes = new Map<string, ModuleExportIndexV1>([
      [
        'src/barrel.ts',
        index({
          named: {},
          reexports: [{ exported: '*', imported: '*', specifier: './shared' }],
        }),
      ],
      ['src/shared.ts', index({ named: {}, default: target('src/shared.ts', 'Main', 'Main') })],
    ]);

    expect(resolveExport('src/barrel.ts', 'default', indexes, resolveModule)).toEqual({
      status: 'missing',
    });
  });

  it('reports an unproductive barrel cycle without recursing forever', () => {
    const indexes = new Map<string, ModuleExportIndexV1>([
      [
        'src/cycle-a.ts',
        index({
          named: {},
          reexports: [{ exported: '*', imported: '*', specifier: './cycle-b' }],
        }),
      ],
      [
        'src/cycle-b.ts',
        index({
          named: {},
          reexports: [{ exported: '*', imported: '*', specifier: './cycle-a' }],
        }),
      ],
    ]);

    expect(resolveExport('src/cycle-a.ts', 'value', indexes, resolveModule)).toEqual({
      status: 'cycle',
    });
  });

  it('returns missing for absent indexes, exports, and unresolved re-export modules', () => {
    const indexes = new Map<string, ModuleExportIndexV1>([
      [
        'src/barrel.ts',
        index({
          named: {},
          reexports: [{ exported: '*', imported: '*', specifier: './missing' }],
        }),
      ],
    ]);

    expect(resolveExport('src/absent.ts', 'value', indexes, resolveModule)).toEqual({
      status: 'missing',
    });
    expect(resolveExport('src/barrel.ts', 'value', indexes, resolveModule)).toEqual({
      status: 'missing',
    });
  });
});
