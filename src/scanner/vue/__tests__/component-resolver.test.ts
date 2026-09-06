import { describe, expect, it } from 'vitest';
import type { ProjectResolutionContextV1 } from '../../contracts/program.js';
import { vueComponentId } from '../../identity/program-identity.js';
import type { VueSfcFactsV1 } from '../types.js';
import { VueComponentResolver } from '../component-resolver.js';

function facts(path: string, overrides: Partial<VueSfcFactsV1> = {}): VueSfcFactsV1 {
  return {
    schemaVersion: 1,
    languageId: 'vue',
    filePath: path,
    componentId: vueComponentId(path),
    declarations: [],
    references: [],
    diagnostics: [],
    imports: [],
    optionsComponents: {},
    templateElements: [],
    templateListeners: [],
    calls: [],
    stores: [],
    events: [],
    compilerDiagnostics: [],
    ...overrides,
  };
}

function project(paths: string[]): ProjectResolutionContextV1 {
  return {
    rootPath: '/repo',
    sourceFiles: new Set(paths),
    aliases: [],
    workspacePackages: [],
    exportsByFile: new Map(),
    fingerprintInputs: [],
  };
}

describe('VueComponentResolver', () => {
  it('renders an imported child with canonical identities and dual evidence', async () => {
    const parent = facts('src/Parent.vue', {
      imports: [
        {
          localName: 'ChildCard',
          importedName: 'default',
          specifier: './Child.vue',
          location: { filePath: 'src/Parent.vue', line: 2, column: 7 },
        },
      ],
      templateElements: [
        { tag: 'child-card', location: { filePath: 'src/Parent.vue', line: 8, column: 2 } },
      ],
    });
    const child = facts('src/Child.vue');
    const edges = await new VueComponentResolver({ now: () => 1 }).resolve(
      [parent, child],
      project(['src/Parent.vue', 'src/Child.vue'])
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceNodeId: vueComponentId('src/Parent.vue'),
      targetNodeId: vueComponentId('src/Child.vue'),
      edgeType: 'renders_component',
      confidenceClass: 'framework-inferred',
    });
    expect(edges[0].provenance.evidenceLocations).toHaveLength(2);
  });

  it('does not render imported-unused, native, or dynamic component tags', async () => {
    const diagnostics: string[] = [];
    const parent = facts('src/Parent.vue', {
      imports: [
        {
          localName: 'UnusedChild',
          importedName: 'default',
          specifier: './Child.vue',
          location: { filePath: 'src/Parent.vue', line: 1, column: 7 },
        },
      ],
      templateElements: [
        { tag: 'div', location: { filePath: 'src/Parent.vue', line: 4, column: 0 } },
        { tag: 'component', location: { filePath: 'src/Parent.vue', line: 5, column: 0 } },
      ],
    });
    const edges = await new VueComponentResolver({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    }).resolve([parent, facts('src/Child.vue')], project(['src/Parent.vue', 'src/Child.vue']));
    expect(edges).toEqual([]);
    expect(diagnostics).toContain('vue-component-dynamic');
  });
});
