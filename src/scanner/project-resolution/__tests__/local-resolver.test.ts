import { describe, expect, it } from 'vitest';
import { resolveLocalModule } from '../local-resolver.js';
import type { ModuleResolutionRequestV1 } from '../types.js';

const importerFile = 'src/features/caller.ts';

function request(
  specifier: string,
  overrides: Partial<ModuleResolutionRequestV1> = {}
): ModuleResolutionRequestV1 {
  return {
    importerFile,
    specifier,
    mode: 'import',
    ...overrides,
  };
}

function resolved(targetFile: string) {
  return { status: 'resolved', targetFile, via: 'relative' } as const;
}

describe('resolveLocalModule', () => {
  it.each([
    ['../modules/typescript', 'src/modules/typescript.ts'],
    ['../modules/typescript-react', 'src/modules/typescript-react.tsx'],
    ['../modules/javascript', 'src/modules/javascript.js'],
    ['../modules/javascript-react', 'src/modules/javascript-react.jsx'],
    ['../modules/esm', 'src/modules/esm.mjs'],
    ['../modules/commonjs', 'src/modules/commonjs.cjs'],
    ['../modules/component', 'src/modules/component.vue'],
  ])('resolves extensionless %s to %s', (specifier, targetFile) => {
    expect(resolveLocalModule(request(specifier), new Set([targetFile]))).toEqual(
      resolved(targetFile)
    );
  });

  it.each([
    ['../modules/typescript', 'src/modules/typescript/index.ts'],
    ['../modules/typescript-react', 'src/modules/typescript-react/index.tsx'],
    ['../modules/javascript', 'src/modules/javascript/index.js'],
    ['../modules/javascript-react', 'src/modules/javascript-react/index.jsx'],
    ['../modules/esm', 'src/modules/esm/index.mjs'],
    ['../modules/commonjs', 'src/modules/commonjs/index.cjs'],
    ['../modules/component', 'src/modules/component/index.vue'],
  ])('resolves index path %s to %s', (specifier, targetFile) => {
    expect(resolveLocalModule(request(specifier), new Set([targetFile]))).toEqual(
      resolved(targetFile)
    );
  });

  it('resolves root-relative specifiers from the repository root', () => {
    expect(
      resolveLocalModule(request('/src/modules/component'), new Set(['src/modules/component.vue']))
    ).toEqual(resolved('src/modules/component.vue'));
  });

  it('normalizes Windows separators in importer and specifier paths', () => {
    expect(
      resolveLocalModule(
        request('..\\modules\\typescript', { importerFile: 'src\\features\\caller.ts' }),
        new Set(['src/modules/typescript.ts'])
      )
    ).toEqual(resolved('src/modules/typescript.ts'));
  });

  it.each(['../exact.js', '../exact.jsx', '../exact.mjs', '../exact.cjs'])(
    'gives an exact scanned JavaScript path precedence for %s',
    (specifier) => {
      const targetFile = `src/${specifier.slice(3)}`;
      const sourceBase = targetFile.replace(/\.(?:mjs|cjs|js|jsx)$/u, '');
      const files = new Set([targetFile, `${sourceBase}.ts`, `${sourceBase}.tsx`]);
      expect(resolveLocalModule(request(specifier), files)).toEqual(resolved(targetFile));
    }
  );

  it.each([
    ['../emitted.js', 'src/emitted.ts'],
    ['../emitted.jsx', 'src/emitted.tsx'],
    ['../emitted.mjs', 'src/emitted.ts'],
    ['../emitted.cjs', 'src/emitted.ts'],
  ])('strips emitted suffix in %s only after exact lookup', (specifier, targetFile) => {
    expect(resolveLocalModule(request(specifier), new Set([targetFile]))).toEqual(
      resolved(targetFile)
    );
  });

  it('reports extension ambiguity in deterministic lexical order', () => {
    const files = new Set([
      'src/modules/value/index.vue',
      'src/modules/value.tsx',
      'src/modules/value.js',
      'src/modules/value.ts',
    ]);

    expect(resolveLocalModule(request('../modules/value'), files)).toEqual({
      status: 'ambiguous',
      candidates: [
        'src/modules/value.js',
        'src/modules/value.ts',
        'src/modules/value.tsx',
        'src/modules/value/index.vue',
      ],
      governingConfigs: [],
    });
  });

  it('reports stripped emitted-source ambiguity without mixing in absent exact path', () => {
    expect(
      resolveLocalModule(
        request('../emitted.js'),
        new Set(['src/emitted.vue', 'src/emitted.tsx', 'src/emitted.ts'])
      )
    ).toEqual({
      status: 'ambiguous',
      candidates: ['src/emitted.ts', 'src/emitted.tsx', 'src/emitted.vue'],
      governingConfigs: [],
    });
  });

  it.each(['package', '@scope/package', 'node:fs', '#internal'])(
    'leaves non-local specifier %s to later resolvers',
    (specifier) => {
      expect(resolveLocalModule(request(specifier), new Set())).toBeUndefined();
    }
  );

  it.each([
    '../../../outside',
    '..\\..\\..\\outside',
    '/../../outside',
    '../modules/control\npath',
    '../modules/control\u0000path',
  ])('returns missing for traversal or control path %j', (specifier) => {
    expect(resolveLocalModule(request(specifier), new Set(['outside.ts']))).toEqual({
      status: 'missing',
      specifier,
    });
  });

  it.each(['../missing', '../missing.ts', '/missing', './missing.js'])(
    'returns missing for local target %s',
    (specifier) => {
      expect(resolveLocalModule(request(specifier), new Set())).toEqual({
        status: 'missing',
        specifier,
      });
    }
  );

  it.each([
    '/absolute/importer.ts',
    '../escaping/importer.ts',
    'src/control\nimporter.ts',
    'src/control\u0000importer.ts',
  ])('returns missing for invalid importer %j', (invalidImporter) => {
    expect(
      resolveLocalModule(
        request('./target', { importerFile: invalidImporter }),
        new Set(['target.ts'])
      )
    ).toEqual({ status: 'missing', specifier: './target' });
  });

  it.each<ModuleResolutionRequestV1['mode']>(['import', 'require', 'reexport', 'dynamic-import'])(
    'uses identical local resolution for %s mode',
    (mode) => {
      expect(
        resolveLocalModule(
          request('../modules/typescript', { mode }),
          new Set(['src/modules/typescript.ts'])
        )
      ).toEqual(resolved('src/modules/typescript.ts'));
    }
  );
});
