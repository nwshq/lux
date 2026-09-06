import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bladeTemplateId } from '../../../../identity/program-identity.js';
import type { AssociationContext } from '../../../types.js';
import { phpSymbolNodeId } from '../../../types.js';
import { extractBladeLivewireFacts } from '../blade-livewire.js';
import { extractLivewireFacts } from '../livewire-facts.js';
import { resolveLivewire } from '../livewire-resolver.js';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/livewire');

function fixtureContext(): AssociationContext {
  const visit = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? visit(path) : [path];
    });
  return {
    rootPath: fixtureRoot,
    nodes: [],
    entries: visit(fixtureRoot).map((path) => ({
      filePath: relative(fixtureRoot, path).replaceAll('\\', '/'),
      metadata: { content: readFileSync(path, 'utf8') },
    })),
    dirtyFiles: [],
  };
}

function contextWith(files: Record<string, string>): AssociationContext {
  return {
    rootPath: '/repo',
    nodes: [],
    entries: Object.entries(files).map(([filePath, content]) => ({
      filePath,
      metadata: { content },
    })),
    dirtyFiles: [],
  };
}

describe('Livewire static bridge', () => {
  it('extracts first-party classes, literal views, registrations, namespaces, and mount forms', () => {
    const context = fixtureContext();
    const php = extractLivewireFacts(context);
    const blade = extractBladeLivewireFacts(context);

    expect(php.classes.map((item) => item.qualifiedName)).toEqual([
      'App\\Livewire\\Admin\\UserTable',
      'App\\Livewire\\RegisteredPanel',
      'App\\Livewire\\WelcomePanel',
    ]);
    expect(php.classes.find((item) => item.name === 'WelcomePanel')?.conventionalName).toBe(
      'welcome-panel'
    );
    expect(php.registrations).toEqual([
      expect.objectContaining({
        alias: 'marketing.hero',
        className: 'App\\Livewire\\RegisteredPanel',
      }),
    ]);
    expect(php.viewNamespaces).toEqual([
      expect.objectContaining({ namespace: 'acme', roots: ['resources/views/vendor/acme'] }),
    ]);
    expect(blade.mounts.map(({ name, form }) => [name, form])).toEqual([
      ['admin.user-table', 'tag-self-closing'],
      ['welcome-panel', 'directive'],
      ['marketing.hero', 'facade'],
    ]);
    expect([...php.diagnostics, ...blade.diagnostics]).toEqual([]);
  });

  it('resolves literal, conventional, namespaced, layout, and registered edges deterministically', () => {
    const result = resolveLivewire(fixtureContext(), { now: () => 42 });

    expect(result.diagnostics).toEqual([]);
    expect(result.nodes).toHaveLength(4);
    expect(result.edges).toHaveLength(6);
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'renders_template',
          sourceNodeId: phpSymbolNodeId('App\\Livewire\\Admin\\UserTable'),
          targetNodeId: bladeTemplateId('resources/views/livewire/admin/user-table.blade.php'),
          provenance: expect.objectContaining({ evidenceKind: 'livewire-literal-render' }),
        }),
        expect.objectContaining({
          edgeType: 'hydrates_component',
          sourceNodeId: bladeTemplateId('resources/views/pages/dashboard.blade.php'),
          targetNodeId: phpSymbolNodeId('App\\Livewire\\RegisteredPanel'),
          provenance: expect.objectContaining({ evidenceKind: 'livewire-facade-mount' }),
        }),
      ])
    );
  });

  it('fails closed for dynamic evidence, traversal, vendor files, and unqualified basename mounts', () => {
    const context = contextWith({
      'app/Livewire/One/Duplicate.php':
        '<?php namespace App\\Livewire\\One; use Livewire\\Component; class Duplicate extends Component {}',
      'app/Livewire/Two/Duplicate.php':
        '<?php namespace App\\Livewire\\Two; use Livewire\\Component; class Duplicate extends Component {}',
      'resources/views/page.blade.php': '@livewire($name)\n<livewire:duplicate />',
      'vendor/acme/resources/views/ignored.blade.php': '<livewire:duplicate />',
      '../escape.blade.php': '<livewire:duplicate />',
    });

    const result = resolveLivewire(context, { now: () => 42 });
    expect(result.edges).toEqual([]);
    expect(result.diagnostics.map((item) => item.code).sort()).toEqual([
      'livewire-component-missing',
      'livewire-dynamic-mount',
    ]);
  });

  it('reports Volt and anonymous components as unsupported without emitting edges', () => {
    const context = contextWith({
      'resources/views/livewire/counter.blade.php':
        "<?php use function Livewire\\Volt\\{state}; state(['count' => 0]); ?>",
      'app/Livewire/anonymous.php':
        "<?php use Livewire\\Component; return new class extends Component { function render(){ return view('livewire.secret'); } };",
      'resources/views/livewire/secret.blade.php': 'secret',
    });

    const result = resolveLivewire(context, { now: () => 42 });
    expect(result.edges).toEqual([]);
    expect(result.diagnostics.map((item) => item.code).sort()).toEqual([
      'livewire-anonymous-unsupported',
      'livewire-volt-unsupported',
    ]);
  });
});
