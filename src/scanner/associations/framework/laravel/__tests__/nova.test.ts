import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { StructuralNode } from '../../../../../db/types.js';
import { novaArtifactId, vueComponentId } from '../../../../identity/program-identity.js';
import type { AssociationContext } from '../../../types.js';
import { fileNodeId, phpSymbolNodeId } from '../../../types.js';
import { extractNovaFacts } from '../nova-facts.js';
import { resolveNova } from '../nova-resolver.js';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/nova');

function visit(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? visit(path) : [path];
  });
}

function fixtureContext(): AssociationContext {
  const entries = visit(fixtureRoot).map((path) => ({
    filePath: relative(fixtureRoot, path).replaceAll('\\', '/'),
    languageId: language(path),
    metadata: { content: readFileSync(path, 'utf8') },
  }));
  const shell: AssociationContext = {
    rootPath: fixtureRoot,
    nodes: [],
    entries,
    dirtyFiles: [],
  };
  const facts = extractNovaFacts(shell);
  const now = 1;
  const phpNodes = facts.classes.map((item): StructuralNode => ({
    id: phpSymbolNodeId(item.qualifiedName),
    node_type: 'symbol',
    file_path: item.filePath,
    language_id: 'php',
    symbol_name: item.name,
    symbol_kind: 'Class',
    qualified_name: item.qualifiedName,
    origin: 'local',
    updated_at: now,
  }));
  const frontendNodes = entries.flatMap(({ filePath }): StructuralNode[] => {
    if (filePath.endsWith('.vue')) {
      return [
        {
          id: vueComponentId(filePath),
          node_type: 'symbol',
          file_path: filePath,
          language_id: 'vue',
          symbol_name: filePath
            .split('/')
            .at(-1)
            ?.replace(/\.vue$/u, ''),
          symbol_kind: 'VueComponent',
          origin: 'local',
          updated_at: now,
        },
      ];
    }
    if (/\.(?:[cm]?[jt]sx?)$/u.test(filePath)) {
      return [
        {
          id: fileNodeId(filePath),
          node_type: 'file',
          file_path: filePath,
          language_id: language(filePath),
          symbol_name: filePath.split('/').at(-1),
          symbol_kind: 'File',
          origin: 'local',
          updated_at: now,
        },
      ];
    }
    return [];
  });
  return { ...shell, nodes: [...phpNodes, ...frontendNodes] };
}

function contextWith(
  files: Record<string, string>,
  nodes: StructuralNode[] = []
): AssociationContext {
  return {
    rootPath: '/repo',
    nodes,
    entries: Object.entries(files).map(([filePath, content]) => ({
      filePath,
      languageId: language(filePath),
      metadata: { content },
    })),
    dirtyFiles: [],
  };
}

function language(path: string): string {
  if (path.endsWith('.php')) return 'php';
  if (path.endsWith('.vue')) return 'vue';
  if (/\.tsx?$/u.test(path)) return 'typescript';
  if (/\.[cm]?jsx?$/u.test(path)) return 'javascript';
  return 'css';
}

const positiveEdges: Array<[string, string, string]> = [
  ['provides_capability', 'App\\Providers\\NovaServiceProvider', 'App\\Nova\\Offer'],
  ['provides_capability', 'App\\Providers\\NovaServiceProvider', 'App\\Nova\\Contact'],
  ['provides_capability', 'App\\Providers\\NovaServiceProvider', 'App\\Nova\\BusinessEntity'],
  ['provides_capability', 'App\\Providers\\NovaServiceProvider', 'App\\Nova\\Discovered\\Address'],
  ['provides_capability', 'App\\Providers\\NovaServiceProvider', 'App\\Nova\\Tools\\MetricsTool'],
  ['provides_capability', 'App\\Providers\\NovaServiceProvider', 'App\\Nova\\Tools\\AuditTool'],
  [
    'provides_capability',
    'App\\Module\\Offers\\ServiceProvider',
    'App\\Module\\Offers\\Nova\\Offer',
  ],
  [
    'provides_capability',
    'App\\Module\\Offers\\ServiceProvider',
    'App\\Module\\Offers\\Nova\\OfferChain',
  ],
  [
    'provides_capability',
    'App\\Module\\Contact\\ServiceProvider',
    'App\\Module\\Contact\\Nova\\Contact',
  ],
  [
    'provides_capability',
    'App\\Module\\BusinessEntity\\ServiceProvider',
    'App\\Module\\BusinessEntity\\Nova\\BusinessEntity',
  ],
  [
    'provides_capability',
    'App\\Module\\BusinessEntity\\ServiceProvider',
    'App\\Module\\BusinessEntity\\Nova\\BusinessEntityAddress',
  ],
  ['transforms_model', 'App\\Nova\\Offer', 'App\\Models\\Offer'],
  ['transforms_model', 'App\\Nova\\Contact', 'App\\Models\\Contact'],
  ['transforms_model', 'App\\Nova\\BusinessEntity', 'App\\Models\\BusinessEntity'],
  ['transforms_model', 'App\\Nova\\Discovered\\Address', 'App\\Models\\Address'],
  ['transforms_model', 'App\\Module\\Offers\\Nova\\Offer', 'App\\Models\\Offer'],
  ['transforms_model', 'App\\Module\\Offers\\Nova\\OfferChain', 'App\\Models\\Offer'],
  ['transforms_model', 'App\\Module\\Contact\\Nova\\Contact', 'App\\Models\\Contact'],
  [
    'transforms_model',
    'App\\Module\\BusinessEntity\\Nova\\BusinessEntity',
    'App\\Models\\BusinessEntity',
  ],
  [
    'transforms_model',
    'App\\Module\\BusinessEntity\\Nova\\BusinessEntityAddress',
    'App\\Models\\Address',
  ],
];

function endpointId(edgeType: string, value: string): string {
  return edgeType === 'hydrates_component' ? value : phpSymbolNodeId(value);
}

describe('Nova static facts and graph', () => {
  it('extracts arrays, provider methods, resourcesIn, tools, models, assets, and components', () => {
    const facts = extractNovaFacts(fixtureContext());
    expect(facts.registrations).toHaveLength(12);
    expect(facts.classes.filter((item) => item.kind === 'resource')).toHaveLength(9);
    expect(facts.classes.filter((item) => item.kind === 'tool')).toHaveLength(2);
    expect(facts.classes.filter((item) => item.kind === 'card')).toHaveLength(1);
    expect(facts.assets.map(({ kind, name }) => [kind, name])).toEqual([
      ['script', 'dashboard-sfc'],
      ['script', 'nova-shell'],
      ['style', 'nova-theme'],
    ]);
    expect(facts.frontendComponents.map((item) => item.name)).toEqual([
      'audit-tool',
      'metrics-tool',
      'status-card',
    ]);
    expect(facts.diagnostics).toEqual([]);
  });

  it.each(positiveEdges)(
    'emits positive static edge %#: %s %s -> %s',
    (edgeType, source, target) => {
      const result = resolveNova(fixtureContext(), { now: () => 42 });
      expect(result.edges).toContainEqual(
        expect.objectContaining({
          edgeType,
          sourceNodeId: endpointId(edgeType, source),
          targetNodeId: endpointId(edgeType, target),
          confidenceClass: 'artifact-backed',
        })
      );
    }
  );

  it.each([
    ['nova-shell', fileNodeId('resources/js/nova.js')],
    ['dashboard-sfc', vueComponentId('resources/js/components/Dashboard.vue')],
  ])('hydrates script artifact %# to its exact existing target', (name, targetNodeId) => {
    const result = resolveNova(fixtureContext(), { now: () => 42 });
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        edgeType: 'hydrates_component',
        sourceNodeId: novaArtifactId('app/Providers/NovaServiceProvider.php', name),
        targetNodeId,
      })
    );
  });

  it.each([
    ['metrics-tool', 'app/Nova/Tools/MetricsTool.php', 'MetricsTool.vue'],
    ['audit-tool', 'app/Nova/Tools/AuditTool.php', 'AuditTool.vue'],
    ['status-card', 'app/Nova/Cards/StatusCard.php', 'StatusCard.vue'],
  ])('hydrates tool/card artifact %# to its exact component', (name, ownerFile, component) => {
    const result = resolveNova(fixtureContext(), { now: () => 42 });
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        edgeType: 'hydrates_component',
        sourceNodeId: novaArtifactId(ownerFile, name),
        targetNodeId: vueComponentId(`resources/js/components/${component}`),
      })
    );
  });

  it('materializes script, style, tool, and card artifacts ready for central persistence', () => {
    const result = resolveNova(fixtureContext(), { now: () => 42 });
    expect(result.nodes.filter((node) => node.node_type === 'artifact')).toHaveLength(6);
    expect(result.nodes).toContainEqual(
      expect.objectContaining({
        id: novaArtifactId('app/Providers/NovaServiceProvider.php', 'nova-theme'),
        symbol_kind: 'NovaStyle',
      })
    );
    expect(result.edges).toHaveLength(25);
    expect(new Set(result.edges.map((edge) => edge.id)).size).toBe(25);
    expect(result.diagnostics).toEqual([]);
  });
});

const forbiddenCases: Array<[string, Record<string, string>, string]> = [
  [
    'dynamic resource array',
    {
      'app/P.php': `<?php namespace App; use Laravel\\Nova\\Nova; class P { function boot(){ Nova::resources($items); } }`,
    },
    'nova-dynamic-registration',
  ],
  [
    'computed resource array',
    {
      'app/P.php': `<?php namespace App; use Laravel\\Nova\\Nova; class P { function boot(){ Nova::resources(array_merge([R::class], more())); } }`,
    },
    'nova-dynamic-registration',
  ],
  [
    'dynamic provider return',
    {
      'app/P.php': `<?php namespace App; class P { function resources(){ return $this->items(); } }`,
    },
    'nova-dynamic-provider-method',
  ],
  [
    'runtime tool method return',
    {
      'app/P.php': `<?php namespace App; class P { function tools(){ if ($ok) return [new T]; return []; } }`,
    },
    'nova-dynamic-provider-method',
  ],
  [
    'dynamic resourcesIn path',
    {
      'app/P.php': `<?php namespace App; use Laravel\\Nova\\Nova; class P { function boot(){ Nova::resourcesIn($path); } }`,
    },
    'nova-resources-in-invalid',
  ],
  [
    'traversing resourcesIn path',
    {
      'app/P.php': `<?php namespace App; use Laravel\\Nova\\Nova; class P { function boot(){ Nova::resourcesIn('../vendor/acme'); } }`,
      'vendor/acme/R.php': `<?php namespace Vendor; class R extends \\Laravel\\Nova\\Resource {}`,
    },
    'nova-resources-in-invalid',
  ],
  [
    'unscanned registration target',
    {
      'app/P.php': `<?php namespace App; use Laravel\\Nova\\Nova; class P { function boot(){ Nova::resources([Missing::class]); } }`,
    },
    'nova-registration-target-missing',
  ],
  [
    'non-resource target',
    {
      'app/P.php': `<?php namespace App; use Laravel\\Nova\\Nova; class Plain {} class P { function boot(){ Nova::resources([Plain::class]); } }`,
    },
    'nova-registration-target-missing',
  ],
  [
    'dynamic model property',
    {
      'app/R.php': `<?php namespace App; class R extends \\Laravel\\Nova\\Resource { public static $model = MODEL; }`,
    },
    'nova-dynamic-model',
  ],
  [
    'dynamic script path',
    {
      'app/P.php': `<?php namespace App; use Laravel\\Nova\\Nova; class P { function boot(){ Nova::script('x', $path); } }`,
    },
    'nova-asset-invalid',
  ],
  [
    'missing style file',
    {
      'app/P.php': `<?php namespace App; use Laravel\\Nova\\Nova; class P { function boot(){ Nova::style('x', 'resources/missing.css'); } }`,
    },
    'nova-asset-invalid',
  ],
  [
    'traversing script path',
    {
      'app/P.php': `<?php namespace App; use Laravel\\Nova\\Nova; class P { function boot(){ Nova::script('x', __DIR__ . '/../../../vendor/x.js'); } }`,
      'vendor/x.js': 'export default {}',
    },
    'nova-asset-invalid',
  ],
  [
    'dynamic frontend component',
    {
      'resources/js/nova.js': `const target = './Widget.vue'; Nova.component(name, require(target));`,
      'resources/js/Widget.vue': '<template />',
    },
    'nova-component-entrypoint-invalid',
  ],
  [
    'package component import',
    {
      'resources/js/nova.js': `import Tool from 'vendor/tool'; Nova.component('tool', Tool);`,
      'vendor/tool.vue': '<template />',
    },
    'nova-component-entrypoint-invalid',
  ],
];

describe('Nova forbidden evidence', () => {
  it.each(forbiddenCases)('fails closed for %#: %s', (_name, files, expectedDiagnostic) => {
    (globalThis as { novaExecuted?: boolean }).novaExecuted = false;
    files['resources/js/no-execution.js'] ??= 'globalThis.novaExecuted = true;';
    const result = resolveNova(contextWith(files), { now: () => 42 });
    expect(result.edges).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain(expectedDiagnostic);
    expect((globalThis as { novaExecuted?: boolean }).novaExecuted).toBe(false);
  });

  it('does not parse comments, strings, unrelated facades, or unrelated static properties', () => {
    const context = contextWith({
      'app/Fake.php': `<?php namespace App;
        // Nova::resources([Missing::class]);
        class Fake { public static $model = Model::class; function boot() {
          $text = "Nova::script('x', 'x.js')"; Other::resources([Missing::class]);
        } }`,
    });
    expect(extractNovaFacts(context)).toEqual({
      classes: [expect.objectContaining({ qualifiedName: 'App\\Fake', kind: 'class' })],
      registrations: [],
      assets: [],
      frontendComponents: [],
      diagnostics: [],
    });
  });

  it('does not bind a missing model by global basename', () => {
    const files = {
      'app/Nova/Order.php': `<?php namespace App\\Nova; use App\\Models\\Order; class OrderResource extends \\Laravel\\Nova\\Resource { public static $model = Order::class; }`,
      'other/Order.php': `<?php namespace Other; class Order {}`,
    };
    const facts = extractNovaFacts(contextWith(files));
    const resource = facts.classes.find((item) => item.kind === 'resource')!;
    const nodes: StructuralNode[] = facts.classes.map((item) => ({
      id: phpSymbolNodeId(item.qualifiedName),
      node_type: 'symbol',
      file_path: item.filePath,
      language_id: 'php',
      symbol_name: item.name,
      symbol_kind: 'Class',
      updated_at: 1,
    }));
    const result = resolveNova(contextWith(files, nodes), { now: () => 42 });
    expect(resource.modelQualifiedName).toBe('App\\Models\\Order');
    expect(result.edges).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain('nova-model-target-missing');
  });

  it('excludes vendor paths unless their canonical root is explicitly promoted first party', () => {
    const files = {
      'vendor/acme/src/R.php': `<?php namespace Acme; class R extends \\Laravel\\Nova\\Resource {}`,
      'vendor/acme/src/P.php': `<?php namespace Acme; use Laravel\\Nova\\Nova; class P { function boot(){ Nova::resources([R::class]); } }`,
    };
    expect(extractNovaFacts(contextWith(files)).classes).toEqual([]);

    const promoted = contextWith({
      '/packages/acme/src/R.php': files['vendor/acme/src/R.php'],
      '/packages/acme/src/P.php': files['vendor/acme/src/P.php'],
    });
    const facts = extractNovaFacts(promoted, { firstPartyRoots: ['/packages/acme'] });
    expect(facts.registrations).toHaveLength(1);
    expect(facts.registrations[0].targetQualifiedName).toBe('Acme\\R');
  });
});
