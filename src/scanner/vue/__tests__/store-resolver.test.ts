import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  ModuleExportIndexV1,
  ProjectResolutionContextV1,
  SourceFactsV1,
} from '../../contracts/program.js';
import { vueComponentId } from '../../identity/program-identity.js';
import type { VueSfcFactsV1, VueStoreDeclarationV1 } from '../types.js';
import { VueStoreResolver, type VueStoreCallFactV1 } from '../store-resolver.js';

interface FixtureCases {
  positive: string[];
  forbidden: string[];
}

const cases = JSON.parse(
  readFileSync(new URL('./fixtures/stores/cases.json', import.meta.url), 'utf8')
) as FixtureCases;

function component(
  path: string,
  imports: VueSfcFactsV1['imports'],
  calls: VueStoreCallFactV1[],
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

function storeFacts(
  path: string,
  exportName: string,
  localName: string,
  kind: 'pinia' | 'vuex',
  languageId: 'javascript' | 'typescript' = 'typescript'
): SourceFactsV1 & { stores: VueStoreDeclarationV1[] } {
  return {
    schemaVersion: 1,
    languageId,
    filePath: path,
    declarations: [
      {
        localId: localName,
        kind: 'function',
        name: localName,
        location: { filePath: path, line: 2, column: 13 },
      },
    ],
    references: [],
    diagnostics: [],
    stores: [
      {
        exportName,
        localName,
        kind,
        location: { filePath: path, line: 2, column: 13 },
      },
    ],
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

function directExport(path: string, exported: string, localName = exported): ModuleExportIndexV1 {
  const target = { filePath: path, localName, declarationId: localName };
  return {
    ...(exported === 'default' ? { default: target } : { named: { [exported]: target } }),
    named: exported === 'default' ? {} : { [exported]: target },
    reexports: [],
  };
}

function binding(
  filePath: string,
  localName: string,
  importedName: string,
  specifier: string,
  line = 2
) {
  return {
    localName,
    importedName,
    specifier,
    location: { filePath, line, column: 7 },
  };
}

function call(filePath: string, localName: string, line = 8): VueStoreCallFactV1 {
  return {
    callee: localName,
    localBinding: localName,
    location: { filePath, line, column: 0 },
  };
}

describe('VueStoreResolver', () => {
  it('meets the dedicated fixture cohort minimums', () => {
    expect(cases.positive.length).toBeGreaterThanOrEqual(20);
    expect(cases.forbidden.length).toBeGreaterThanOrEqual(10);
  });

  it('resolves at least twenty Pinia/Vuex JS/TS, alias, barrel, and duplicate-name cases', async () => {
    const facts: SourceFactsV1[] = [];
    const paths = new Set<string>();
    const indexes = new Map<string, ModuleExportIndexV1>();
    const aliases: ProjectResolutionContextV1['aliases'][number][] = [];

    for (let index = 0; index < cases.positive.length; index += 1) {
      const vuex = index >= 12;
      const storeName = vuex ? `store${index}` : `useFeature${index}Store`;
      const exportName = vuex && index <= 15 ? 'default' : storeName;
      const sourcePath = `src/stores/store${index}.${index % 2 === 0 ? 'ts' : 'js'}`;
      const viewPath = `src/components/View${index}.vue`;
      const localName = `localStore${index}`;
      let specifier = `../stores/store${index}`;
      paths.add(sourcePath);
      paths.add(viewPath);
      facts.push(
        storeFacts(
          sourcePath,
          exportName,
          exportName === 'default' ? 'default' : storeName,
          vuex ? 'vuex' : 'pinia',
          index % 2 === 0 ? 'typescript' : 'javascript'
        )
      );
      indexes.set(sourcePath, directExport(sourcePath, exportName));

      if (index === 6 || index === 18 || index === 20) {
        const barrelPath = `src/stores/barrel${index}.ts`;
        paths.add(barrelPath);
        indexes.set(barrelPath, {
          named: {},
          reexports: [
            {
              exported: exportName,
              imported: exportName,
              specifier: `./store${index}`,
            },
          ],
        });
        specifier = `../stores/barrel${index}`;
      } else if (index === 7 || index === 8 || index === 21) {
        specifier = `@store${index}`;
        aliases.push({
          pattern: specifier,
          targets: [sourcePath],
          source: index === 8 ? 'vite' : 'tsconfig',
          configFile: index === 8 ? 'vite.config.ts' : 'tsconfig.json',
          precedence: index,
        });
      }

      if (index >= 18) {
        const useStoreName = index === 19 ? 'getVuexStore' : 'useStore';
        const keyName = `key${index}`;
        facts.push(
          component(
            viewPath,
            [
              binding(viewPath, useStoreName, 'useStore', 'vuex'),
              binding(viewPath, keyName, exportName, specifier, 3),
            ],
            [
              {
                ...call(viewPath, useStoreName),
                argumentBindings: [keyName],
              },
            ]
          )
        );
      } else {
        const directCall = call(viewPath, localName);
        if (vuex && index >= 16) {
          directCall.callee = `${localName}.${index === 16 ? 'dispatch' : 'commit'}`;
          delete directCall.localBinding;
        }
        facts.push(
          component(
            viewPath,
            [binding(viewPath, localName, exportName, specifier)],
            [
              directCall,
              ...(index === 9
                ? [{ ...directCall, location: { ...directCall.location, line: 9 } }]
                : []),
            ]
          )
        );
      }
    }

    const edges = await new VueStoreResolver({ now: () => 42 }).resolve(
      facts,
      project([...paths], indexes, aliases)
    );
    expect(edges).toHaveLength(cases.positive.length);
    expect(edges.every((edge) => edge.edgeType === 'uses_store')).toBe(true);
    expect(edges.every((edge) => edge.confidenceClass === 'framework-inferred')).toBe(true);
    expect(edges.every((edge) => edge.provenance.evidenceLocations.length >= 3)).toBe(true);
    expect(new Set(edges.map((edge) => edge.targetNodeId)).size).toBe(cases.positive.length);
  });

  it('rejects imported-unused, shadows, dynamic/unresolved and global/string store guesses', async () => {
    const viewPath = 'src/components/Forbidden.vue';
    const piniaPath = 'src/stores/account.ts';
    const vuexPath = 'src/stores/vuex.ts';
    const imports = [
      binding(viewPath, 'unusedStore', 'useAccountStore', '../stores/account'),
      binding(viewPath, 'uncalledStore', 'useAccountStore', '../stores/account'),
      binding(viewPath, 'shadowedStore', 'useAccountStore', '../stores/account'),
      binding(viewPath, 'missingStore', 'useMissingStore', '@missing/store'),
      binding(viewPath, 'useStore', 'useStore', 'vuex'),
      binding(viewPath, 'vuexKey', 'default', '../stores/vuex'),
      binding(viewPath, 'namespace', '*', '../stores/account'),
    ];
    const calls: VueStoreCallFactV1[] = [
      { ...call(viewPath, 'shadowedStore') },
      { ...call(viewPath, 'missingStore') },
      { ...call(viewPath, 'useStore'), argumentBindings: [] },
      { ...call(viewPath, 'useStore'), firstStaticString: 'vuexKey' },
      {
        callee: 'this.$store.commit',
        firstStaticString: 'save',
        location: { filePath: viewPath, line: 12, column: 0 },
      },
      {
        callee: 'app.use',
        location: { filePath: viewPath, line: 13, column: 0 },
      },
    ];
    const vuex = storeFacts(vuexPath, 'default', 'default', 'vuex');
    const pinia = storeFacts(piniaPath, 'useAccountStore', 'useAccountStore', 'pinia');
    const view = component(viewPath, imports, calls, [
      {
        localId: 'shadowedStore',
        kind: 'function',
        name: 'shadowedStore',
        location: { filePath: viewPath, line: 5, column: 0 },
      },
    ]);
    const indexes = new Map<string, ModuleExportIndexV1>([
      [piniaPath, directExport(piniaPath, 'useAccountStore')],
      [vuexPath, directExport(vuexPath, 'default')],
    ]);

    const edges = await new VueStoreResolver().resolve(
      [view, pinia, vuex],
      project([viewPath, piniaPath, vuexPath], indexes)
    );
    expect(cases.forbidden.length).toBeGreaterThanOrEqual(10);
    expect(edges).toEqual([]);
  });

  it('requires exactly one imported identifier key and resolves it to one Vuex module', async () => {
    const viewPath = 'src/components/Keyed.vue';
    const vuexPath = 'src/stores/vuex.ts';
    const imports = [
      binding(viewPath, 'getStore', 'useStore', 'vuex'),
      binding(viewPath, 'appKey', 'default', '../stores/vuex', 3),
    ];
    const keyedCall: VueStoreCallFactV1 = {
      ...call(viewPath, 'getStore'),
      argumentBindings: ['appKey'],
    };
    const vuex = storeFacts(vuexPath, 'default', 'default', 'vuex');
    const context = project(
      [viewPath, vuexPath],
      new Map([[vuexPath, directExport(vuexPath, 'default')]])
    );
    const resolver = new VueStoreResolver({ now: () => 1 });

    const first = await resolver.resolve(
      [component(viewPath, imports, [keyedCall]), vuex],
      context
    );
    const second = await resolver.resolve(
      [component(viewPath, imports, [keyedCall]), vuex],
      context
    );
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      sourceNodeId: vueComponentId(viewPath),
      targetNodeId: `symbol:ts:${vuexPath}#default`,
      edgeType: 'uses_store',
    });
    expect(first[0].provenance.evidenceLocations).toHaveLength(4);

    expect(
      await resolver.resolve(
        [
          component(viewPath, imports, [{ ...keyedCall, argumentBindings: ['appKey', 'other'] }]),
          vuex,
        ],
        context
      )
    ).toEqual([]);
    expect(
      await resolver.resolve(
        [component(viewPath, imports, [{ ...keyedCall, argumentBindings: undefined }]), vuex],
        context
      )
    ).toEqual([]);
  });

  it('recomputes source/config-sensitive results without retaining stale edges', async () => {
    const viewPath = 'src/components/Refresh.vue';
    const storePath = 'src/stores/account.ts';
    const store = storeFacts(storePath, 'useAccountStore', 'useAccountStore', 'pinia');
    const importFact = binding(viewPath, 'account', 'useAccountStore', '@store');
    const callFact = call(viewPath, 'account');
    const indexes = new Map([[storePath, directExport(storePath, 'useAccountStore')]]);
    const alias = {
      pattern: '@store',
      targets: [storePath],
      source: 'tsconfig' as const,
      configFile: 'tsconfig.json',
      precedence: 0,
    };
    const resolver = new VueStoreResolver();
    expect(
      await resolver.resolve(
        [component(viewPath, [importFact], [callFact]), store],
        project([viewPath, storePath], indexes, [alias])
      )
    ).toHaveLength(1);
    expect(
      await resolver.resolve(
        [component(viewPath, [importFact], []), store],
        project([viewPath, storePath], indexes, [alias])
      )
    ).toEqual([]);
    expect(
      await resolver.resolve(
        [component(viewPath, [importFact], [callFact]), store],
        project([viewPath, storePath], indexes, [{ ...alias, targets: ['src/stores/other.ts'] }])
      )
    ).toEqual([]);
  });
});
