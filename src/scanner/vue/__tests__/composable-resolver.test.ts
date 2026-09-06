import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  ModuleExportIndexV1,
  ProjectResolutionContextV1,
  SourceFactsV1,
} from '../../contracts/program.js';
import { programEdgeId, vueComponentId } from '../../identity/program-identity.js';
import type { VueSfcFactsV1 } from '../types.js';
import { VueComposableResolver } from '../composable-resolver.js';

interface FixtureCases {
  positive: string[];
  forbidden: string[];
}

const cases = JSON.parse(
  readFileSync(new URL('./fixtures/composables/cases.json', import.meta.url), 'utf8')
) as FixtureCases;

function component(
  path: string,
  imports: VueSfcFactsV1['imports'],
  calls: VueSfcFactsV1['calls'],
  declarations: VueSfcFactsV1['declarations'] = []
): VueSfcFactsV1 {
  return {
    schemaVersion: 1,
    languageId: 'vue',
    filePath: path,
    componentId: vueComponentId(path),
    declarations,
    references: [],
    diagnostics: [],
    imports,
    optionsComponents: {},
    templateElements: [],
    templateListeners: [],
    calls,
    stores: [],
    events: [],
    compilerDiagnostics: [],
  };
}

function source(
  path: string,
  name: string,
  languageId: 'javascript' | 'typescript' = 'typescript',
  kind = 'function'
): SourceFactsV1 {
  return {
    schemaVersion: 1,
    languageId,
    filePath: path,
    declarations: [
      {
        localId: name,
        kind,
        name,
        location: { filePath: path, line: 3, column: 0 },
      },
    ],
    references: [],
    diagnostics: [],
  };
}

function namedExport(path: string, exported: string, local = exported): ModuleExportIndexV1 {
  return {
    named: {
      [exported]: { filePath: path, localName: local, declarationId: local },
    },
    reexports: [],
  };
}

function project(
  paths: readonly string[],
  exportsByFile: ReadonlyMap<string, ModuleExportIndexV1>,
  aliases: ProjectResolutionContextV1['aliases'] = []
): ProjectResolutionContextV1 {
  return {
    rootPath: '/repo',
    sourceFiles: new Set(paths),
    aliases,
    workspacePackages: [],
    exportsByFile,
    fingerprintInputs: aliases.map((alias) => alias.configFile),
  };
}

function imported(localName: string, importedName: string, specifier: string, line = 2) {
  return {
    localName,
    importedName,
    specifier,
    location: { filePath: 'src/components/View.vue', line, column: 7 },
  };
}

function called(localName: string, line = 8) {
  return {
    callee: localName,
    localBinding: localName,
    location: { filePath: 'src/components/View.vue', line, column: 0 },
  };
}

describe('VueComposableResolver', () => {
  it('meets the dedicated fixture cohort minimums', () => {
    expect(cases.positive.length).toBeGreaterThanOrEqual(20);
    expect(cases.forbidden.length).toBeGreaterThanOrEqual(10);
  });

  it('resolves at least twenty JS/TS, alias, barrel, and locally aliased calls', async () => {
    const facts: SourceFactsV1[] = [];
    const paths = new Set<string>();
    const indexes = new Map<string, ModuleExportIndexV1>();
    const aliases: ProjectResolutionContextV1['aliases'][number][] = [];
    const expectedTargets: string[] = [];

    for (let index = 0; index < cases.positive.length; index += 1) {
      const composableName = index === 6 ? 'use2Factor' : `useFeature${index}`;
      const localName = `localComposable${index}`;
      const componentPath = `src/components/View${index}.vue`;
      const sourcePath = `src/composables/${composableName}.${index % 2 === 0 ? 'ts' : 'js'}`;
      let specifier = `../composables/${composableName}`;
      let importedName = composableName;

      facts.push(source(sourcePath, composableName, index % 2 === 0 ? 'typescript' : 'javascript'));
      indexes.set(sourcePath, namedExport(sourcePath, composableName));
      paths.add(sourcePath);
      paths.add(componentPath);

      if (index >= 7 && index <= 8) {
        const barrelPath = `src/composables/barrel${index}.ts`;
        paths.add(barrelPath);
        indexes.set(barrelPath, {
          named: {},
          reexports: [
            {
              exported: composableName,
              imported: composableName,
              specifier: `./${composableName}`,
            },
          ],
        });
        specifier = `../composables/barrel${index}`;
      } else if (index >= 9 && index <= 11) {
        specifier = `@feature${index}`;
        aliases.push({
          pattern: specifier,
          targets: [sourcePath],
          source: index === 11 ? 'vite' : index === 10 ? 'jsconfig' : 'tsconfig',
          configFile: index === 11 ? 'vite.config.ts' : 'tsconfig.json',
          precedence: index,
        });
      } else if (index === 20) {
        importedName = 'publicComposable';
        indexes.set(sourcePath, namedExport(sourcePath, importedName, composableName));
      }

      facts.push(
        component(
          componentPath,
          [
            {
              localName,
              importedName,
              specifier,
              location: { filePath: componentPath, line: 2, column: 7 },
            },
          ],
          [
            {
              callee: localName,
              localBinding: localName,
              location: { filePath: componentPath, line: 8, column: 0 },
            },
            ...(index === 14
              ? [
                  {
                    callee: localName,
                    localBinding: localName,
                    location: { filePath: componentPath, line: 9, column: 0 },
                  },
                ]
              : []),
          ]
        )
      );
      expectedTargets.push(`symbol:ts:${sourcePath}#${composableName}`);
    }

    const edges = await new VueComposableResolver({ now: () => 42 }).resolve(
      facts,
      project([...paths], indexes, aliases)
    );

    expect(edges).toHaveLength(cases.positive.length);
    expect(edges.map((edge) => edge.targetNodeId).sort()).toEqual(expectedTargets.sort());
    expect(edges.every((edge) => edge.confidenceClass === 'framework-inferred')).toBe(true);
    expect(edges.every((edge) => edge.sourceNodeId.startsWith('component:vue:'))).toBe(true);
    expect(edges.every((edge) => edge.provenance.evidenceLocations.length >= 3)).toBe(true);
    expect(edges.find((edge) => edge.provenance.evidenceLocations.length === 4)).toBeDefined();
  });

  it('rejects imports without exact resolved exported function calls', async () => {
    const targetPath = 'src/composables/useAccount.ts';
    const viewPath = 'src/components/View.vue';
    const imports = [
      imported('unused', 'useAccount', '../composables/useAccount'),
      imported('referenced', 'useAccount', '../composables/useAccount'),
      imported('typeOnly', 'useAccount', '../composables/useAccount'),
      imported('propertyOnly', 'useAccount', '../composables/useAccount'),
      imported('lowercase', 'user', '../composables/user'),
      imported('lowerUse', 'useaccount', '../composables/useaccount'),
      imported('underscore', 'use_account', '../composables/use_account'),
      imported('classLike', 'useClass', '../composables/useClass'),
      imported('shadowed', 'useAccount', '../composables/useAccount'),
      imported('missingAlias', 'useMissing', '@missing/useMissing'),
      imported('missingExport', 'useOther', '../composables/useAccount'),
      imported('namespace', '*', '../composables/useAccount'),
    ].map((binding) => ({ ...binding, location: { ...binding.location, filePath: viewPath } }));
    const calls = [
      called('lowercase'),
      called('lowerUse'),
      called('underscore'),
      called('classLike'),
      called('shadowed'),
      called('missingAlias'),
      called('missingExport'),
      { ...called('propertyOnly'), callee: 'object.propertyOnly' },
    ].map((call) => ({ ...call, location: { ...call.location, filePath: viewPath } }));
    const sourceFacts = [
      source(targetPath, 'useAccount'),
      source('src/composables/user.ts', 'user'),
      source('src/composables/useaccount.ts', 'useaccount'),
      source('src/composables/use_account.ts', 'use_account'),
      source('src/composables/useClass.ts', 'useClass', 'typescript', 'class'),
    ];
    const indexes = new Map<string, ModuleExportIndexV1>([
      [targetPath, namedExport(targetPath, 'useAccount')],
      ['src/composables/user.ts', namedExport('src/composables/user.ts', 'user')],
      ['src/composables/useaccount.ts', namedExport('src/composables/useaccount.ts', 'useaccount')],
      [
        'src/composables/use_account.ts',
        namedExport('src/composables/use_account.ts', 'use_account'),
      ],
      ['src/composables/useClass.ts', namedExport('src/composables/useClass.ts', 'useClass')],
    ]);
    const view = component(viewPath, imports, calls, [
      {
        localId: 'shadowed',
        kind: 'function',
        name: 'shadowed',
        location: { filePath: viewPath, line: 5, column: 0 },
      },
    ]);

    const edges = await new VueComposableResolver().resolve(
      [view, ...sourceFacts],
      project([viewPath, ...sourceFacts.map((fact) => fact.filePath)], indexes)
    );
    expect(cases.forbidden.length).toBeGreaterThanOrEqual(10);
    expect(edges).toEqual([]);
  });

  it('is stable and derives source/config refresh results only from current inputs', async () => {
    const sourcePath = 'src/composables/useAccount.ts';
    const viewPath = 'src/components/View.vue';
    const binding = {
      ...imported('account', 'useAccount', '@composable'),
      location: { filePath: viewPath, line: 2, column: 7 },
    };
    const call = { ...called('account'), location: { filePath: viewPath, line: 8, column: 0 } };
    const target = source(sourcePath, 'useAccount');
    const indexes = new Map([[sourcePath, namedExport(sourcePath, 'useAccount')]]);
    const alias = {
      pattern: '@composable',
      targets: [sourcePath],
      source: 'tsconfig' as const,
      configFile: 'tsconfig.json',
      precedence: 0,
    };
    const resolver = new VueComposableResolver({ now: () => 1 });
    const first = await resolver.resolve(
      [component(viewPath, [binding], [call]), target],
      project([viewPath, sourcePath], indexes, [alias])
    );
    const second = await resolver.resolve(
      [component(viewPath, [binding], [call]), target],
      project([viewPath, sourcePath], indexes, [alias])
    );
    expect(first).toEqual(second);
    expect(first[0].id).toBe(
      programEdgeId(
        'uses_composable',
        vueComponentId(viewPath),
        `symbol:ts:${sourcePath}#useAccount`,
        'vue-composable'
      )
    );

    expect(
      await resolver.resolve(
        [component(viewPath, [binding], []), target],
        project([viewPath, sourcePath], indexes, [alias])
      )
    ).toEqual([]);
    expect(
      await resolver.resolve(
        [component(viewPath, [binding], [call]), target],
        project([viewPath, sourcePath], indexes, [{ ...alias, targets: ['src/elsewhere.ts'] }])
      )
    ).toEqual([]);
  });
});
