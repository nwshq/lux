import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { StructuralNode } from '../../../../../db/types.js';
import { extractSource, getGrammars } from '../../../../ast/extract.js';
import { buildAstSymbolNodes } from '../../../../ast/symbols.js';
import type { ProjectResolutionContextV1 } from '../../../../contracts/program.js';
import { vueComponentId } from '../../../../identity/program-identity.js';
import { extractInertiaFacts } from '../inertia-facts.js';
import { buildInertiaPageRegistry } from '../inertia-pages.js';
import { resolveInertiaPageFact } from '../inertia-resolver.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/inertia/', import.meta.url));
const controllerPath = 'app/Http/Controllers/PageController.php';

async function phpFacts(source: string, filePath = controllerPath) {
  const extraction = extractSource(await getGrammars(), source, filePath, 'php').extraction;
  return { extraction, facts: extractInertiaFacts({ filePath, content: source, extraction }) };
}

function project(
  sourceFiles: string[],
  aliases: ProjectResolutionContextV1['aliases'] = []
): ProjectResolutionContextV1 {
  return {
    rootPath: '/repo',
    sourceFiles: new Set(sourceFiles),
    aliases,
    workspacePackages: [],
    exportsByFile: new Map(),
    fingerprintInputs: aliases.map((alias) => alias.configFile),
  };
}

function vueNode(filePath: string): StructuralNode {
  return {
    id: vueComponentId(filePath),
    node_type: 'symbol',
    file_path: filePath,
    language_id: 'vue',
    symbol_name: filePath.split('/').at(-1)?.replace('.vue', ''),
    symbol_kind: 'VueComponent',
    updated_at: 1,
  };
}

describe('Inertia PHP tree-sitter facts', () => {
  it('extracts facade/helper literals and attributes them to the innermost method/function', async () => {
    const content = readFileSync(`${fixtureRoot}controllers.php`, 'utf8');
    const { facts } = await phpFacts(content);
    expect(facts.pages).toHaveLength(5);
    expect(facts.pages.map(({ pageName, ownerName, form }) => [pageName, ownerName, form])).toEqual(
      [
        ['Users/Index', 'facade', 'facade'],
        ['Reports/Show', 'helper', 'helper'],
        ['@contact::Web/ContactIndex', 'namespacePage', 'facade'],
        ['@AcmeCore::Shared/Dashboard', 'legacy', 'helper'],
        ['Landing', 'landing', 'helper'],
      ]
    );
    expect(facts.pages[0].sourceNodeId).toBe(
      'symbol:php:App\\Http\\Controllers\\PageController::facade'
    );
    expect(facts.pages[4].sourceNodeId).toBe('symbol:php:App\\Http\\Controllers\\landing');
    expect(facts.pages.every((fact) => fact.location.line > 0)).toBe(true);
    expect(facts.diagnostics.filter((item) => item.code === 'inertia-page-dynamic')).toHaveLength(
      5
    );
  });

  it.each([
    ["return \\Inertia\\Inertia::render('One');", 'One'],
    ["return inertia( /* page */ 'Two', []);", 'Two'],
    ['return inertia("Three");', 'Three'],
    ["return Inertia::render('Escaped\\\\Path');", 'Escaped\\Path'],
  ])('accepts static form %#', async (statement, expected) => {
    const source = `<?php namespace App; use Inertia\\Inertia; class C { function page(){ ${statement} } }`;
    expect((await phpFacts(source)).facts.pages[0]?.pageName).toBe(expected);
  });

  it.each([
    'inertia($page)',
    "inertia('A' . 'B')",
    "inertia($ok ? 'A' : 'B')",
    'inertia("A/$id")',
    'inertia(null)',
    'inertia(getPage())',
    'inertia(...$args)',
  ])('diagnoses forbidden dynamic expression %#', async (call) => {
    const source = `<?php namespace App; function page($page, $ok, $id, $args){ return ${call}; }`;
    const { facts } = await phpFacts(source);
    expect(facts.pages).toEqual([]);
    expect(facts.diagnostics.map((item) => item.code)).toContain('inertia-page-dynamic');
  });

  it('does not confuse comments, strings, similarly named helpers, or unrelated facades', async () => {
    const source = `<?php namespace App; class C { function page(){
      // Inertia::render('Fake')
      $text = "inertia('Fake')";
      inertial('Fake'); Other::render('Fake'); $x->render('Fake');
    } }`;
    expect((await phpFacts(source)).facts).toEqual({ pages: [], diagnostics: [] });
  });

  it('diagnoses imported helper aliases rather than treating them as literal inertia()', async () => {
    const source = `<?php namespace App; use function inertia as page; function show(){ return page('Users/Index'); }`;
    const { facts } = await phpFacts(source);
    expect(facts.pages).toEqual([]);
    expect(facts.diagnostics[0]?.code).toBe('inertia-page-dynamic');
  });
});

describe('static Inertia page registry', () => {
  const files = [
    'resources/js/Pages/Welcome.vue',
    'resources/js/Pages/Users/Index.vue',
    'resources/js/modules/contact/Web/ContactIndex.vue',
    'resources/js/Other/Users/Index.vue',
  ];

  it('registers configured plain roots and namespace roots with exact component identities', () => {
    const registry = buildInertiaPageRegistry({
      project: project(files),
      config: {
        pageRoots: ['resources/js/Pages'],
        namespaces: { '@contact': ['resources/js/modules/contact'] },
        sourceFile: 'lux.yaml',
      },
    });
    expect(registry.resolve('Users/Index')).toMatchObject({
      componentFile: 'resources/js/Pages/Users/Index.vue',
      componentId: vueComponentId('resources/js/Pages/Users/Index.vue'),
    });
    expect(registry.resolve('@CONTACT::Web/ContactIndex.vue')?.componentFile).toBe(
      'resources/js/modules/contact/Web/ContactIndex.vue'
    );
    expect(registry.dependencies).toContain('lux.yaml');
  });

  it('discovers literal glob roots through the shared alias/project evidence', () => {
    const source = readFileSync(`${fixtureRoot}pages.js`, 'utf8');
    const aliases = [
      {
        pattern: '@contact/*',
        targets: ['resources/js/modules/contact/*'],
        source: 'jsconfig' as const,
        configFile: 'jsconfig.json',
        precedence: 0,
      },
    ];
    const registry = buildInertiaPageRegistry({
      project: project(files, aliases),
      sources: [{ filePath: 'resources/js/pages.js', content: source }],
    });
    expect(registry.resolve('Users/Index')?.componentFile).toBe(
      'resources/js/Pages/Users/Index.vue'
    );
    expect(registry.resolve('@contact::Web/ContactIndex')?.componentFile).toBe(
      'resources/js/modules/contact/Web/ContactIndex.vue'
    );
    expect(registry.resolve('Welcome')?.componentFile).toBe('resources/js/Pages/Welcome.vue');
    expect(registry.resolve('Fake')).toBeUndefined();
    expect(registry.dependencies).toContain('resources/js/pages.js');
  });

  it('supports Acme legacy namespace exactly when backed by its static glob', () => {
    const component = 'resources/js/Shared/Dashboard.vue';
    const registry = buildInertiaPageRegistry({
      project: project(
        [component],
        [
          {
            pattern: '@acmeCore/*',
            targets: ['resources/js/*'],
            source: 'jsconfig',
            configFile: 'jsconfig.json',
            precedence: 0,
          },
        ]
      ),
      sources: [
        {
          filePath: 'resources/js/app.js',
          content: `const core = import.meta.glob('@acmeCore/**/*.vue'); const moduleMap = {'@acmeCore': core};`,
        },
      ],
    });
    expect(registry.resolve('@AcmeCore::Shared/Dashboard')?.componentFile).toBe(component);
  });

  it('refuses ambiguous configured roots instead of selecting by global suffix', () => {
    const registry = buildInertiaPageRegistry({
      project: project(['one/Users/Index.vue', 'two/Users/Index.vue']),
      config: { pageRoots: ['one', 'two'] },
    });
    expect(registry.resolve('Users/Index')).toBeUndefined();
  });

  it.each(['Missing', '../Secret', '/absolute', 'Users\\Index', '@contact::../Secret'])(
    'refuses missing or unsafe page %#',
    (pageName) => {
      const registry = buildInertiaPageRegistry({
        project: project(files),
        config: { pageRoots: ['resources/js/Pages'] },
      });
      expect(registry.resolve(pageName)).toBeUndefined();
    }
  );

  it('ignores dynamic globs and does not execute source code', () => {
    (globalThis as { inertiaExecuted?: boolean }).inertiaExecuted = false;
    const registry = buildInertiaPageRegistry({
      project: project(files),
      sources: [
        {
          filePath: 'resources/js/bad.js',
          content: `globalThis.inertiaExecuted = true; const pages = import.meta.glob(pattern);`,
        },
      ],
    });
    expect(registry.registrations).toEqual([]);
    expect((globalThis as { inertiaExecuted?: boolean }).inertiaExecuted).toBe(false);
  });

  it('refuses traversing configured roots', () => {
    const diagnostics: string[] = [];
    const registry = buildInertiaPageRegistry({
      project: project(files),
      config: { pageRoots: ['../outside'] },
      onDiagnostic: (item) => diagnostics.push(item.code),
    });
    expect(registry.registrations).toEqual([]);
    expect(diagnostics).toContain('inertia-page-root-invalid');
  });
});

describe('Inertia hydration resolver', () => {
  it('emits one method-to-existing-Vue edge with PHP, page, and config evidence', async () => {
    const source = `<?php namespace App; use Inertia\\Inertia; class C { function page(){ return Inertia::render('Users/Index'); } }`;
    const { extraction, facts } = await phpFacts(source, 'app/C.php');
    const phpNodes = buildAstSymbolNodes('app/C.php', extraction, 'php', 1);
    const componentFile = 'resources/js/Pages/Users/Index.vue';
    const registry = buildInertiaPageRegistry({
      project: project([componentFile]),
      config: { pageRoots: ['resources/js/Pages'], sourceFile: 'lux.yaml' },
    });
    const nodes = new Map([...phpNodes, vueNode(componentFile)].map((node) => [node.id, node]));
    const edge = resolveInertiaPageFact(facts.pages[0], registry, nodes, 'laravel-inertia', 7);
    expect(edge).toMatchObject({
      edgeType: 'hydrates_component',
      sourceNodeId: 'symbol:php:App\\C::page',
      targetNodeId: vueComponentId(componentFile),
      confidenceClass: 'framework-inferred',
      confidence: 0.9,
    });
    expect(edge?.provenance.evidenceLocations.map((item) => item.filePath)).toEqual([
      'app/C.php',
      'lux.yaml',
    ]);
  });

  it.each(['missing source', 'missing target'])(
    'requires exact existing endpoints: %s',
    async (missing) => {
      const source = `<?php namespace App; function page(){ return inertia('Users/Index'); }`;
      const { extraction, facts } = await phpFacts(source, 'app/page.php');
      const componentFile = 'resources/js/Pages/Users/Index.vue';
      const registry = buildInertiaPageRegistry({
        project: project([componentFile]),
        config: { pageRoots: ['resources/js/Pages'] },
      });
      const phpNodes = buildAstSymbolNodes('app/page.php', extraction, 'php', 1);
      const all = [...phpNodes, vueNode(componentFile)].filter((node) =>
        missing === 'missing source' ? node.language_id !== 'php' : node.language_id !== 'vue'
      );
      expect(
        resolveInertiaPageFact(
          facts.pages[0],
          registry,
          new Map(all.map((node) => [node.id, node]))
        )
      ).toBeUndefined();
    }
  );

  it('produces only hydration and does not alter the independent page-response contract', async () => {
    const source = `<?php namespace App; function page(){ return inertia('Users/Index'); }`;
    const { extraction, facts } = await phpFacts(source, 'app/page.php');
    const componentFile = 'resources/js/Pages/Users/Index.vue';
    const registry = buildInertiaPageRegistry({
      project: project([componentFile]),
      config: { pageRoots: ['resources/js/Pages'] },
    });
    const nodes = [
      ...buildAstSymbolNodes('app/page.php', extraction, 'php', 1),
      vueNode(componentFile),
    ];
    const edge = resolveInertiaPageFact(
      facts.pages[0],
      registry,
      new Map(nodes.map((node) => [node.id, node]))
    );
    expect(edge?.edgeType).toBe('hydrates_component');
    expect(JSON.stringify(edge)).not.toContain('page-response');
  });
});
