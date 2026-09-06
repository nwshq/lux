import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LuxDatabase } from '../../../db/index.js';
import type { ScanResult } from '../../types.js';
import { phpSymbolNodeId } from '../types.js';
import { rebuildStructuralOverlay } from '../overlay-service.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Phase 14 Nova overlay integration', () => {
  it('stores exact registration and model edges only after PHP endpoints exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lux-nova-overlay-'));
    roots.push(root);
    const files = {
      'app/Models/Offer.php': '<?php namespace App\\Models; class Offer {}',
      'app/Nova/Offer.php': `<?php
namespace App\\Nova;
use Laravel\\Nova\\Resource;
use App\\Models\\Offer as OfferModel;
class Offer extends Resource { public static $model = OfferModel::class; }`,
      'app/Providers/NovaServiceProvider.php': `<?php
namespace App\\Providers;
use Laravel\\Nova\\Nova;
use App\\Nova\\Offer;
class NovaServiceProvider { function boot(){ Nova::resources([Offer::class]); } }`,
    };
    const knowledge: ScanResult['knowledge'] = [];
    for (const [path, content] of Object.entries(files)) {
      const absolute = join(root, path);
      mkdirSync(join(absolute, '..'), { recursive: true });
      writeFileSync(absolute, content);
      knowledge.push({
        type: 'source-code',
        title: path,
        filePath: absolute,
        frontmatter: { language: 'php', extension: '.php' },
        content,
      });
    }
    const db = new LuxDatabase(join(root, 'lux.db'));
    await rebuildStructuralOverlay(db, root, { knowledge }, new Map(), {
      astEnabled: true,
      frameworks: {
        inertia: { pageRoots: [], namespaces: {} },
        livewire: {
          classRoots: ['app/Livewire', 'app/Http/Livewire'],
          viewRoots: ['resources/views/livewire'],
          viewNamespaces: {},
        },
        nova: { enabled: true },
      },
      detectors: [],
      operationalExtractors: [],
    });
    const provider = phpSymbolNodeId('App\\Providers\\NovaServiceProvider');
    const resource = phpSymbolNodeId('App\\Nova\\Offer');
    const model = phpSymbolNodeId('App\\Models\\Offer');
    expect(db.getStructuralNode(provider)).not.toBeNull();
    expect(db.getStructuralNode(resource)).not.toBeNull();
    expect(db.getStructuralNode(model)).not.toBeNull();
    expect(db.getOutgoingStructuralEdges(provider)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ edge_type: 'provides_capability', target_node_id: resource }),
      ])
    );
    expect(db.getOutgoingStructuralEdges(resource)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ edge_type: 'transforms_model', target_node_id: model }),
      ])
    );
    db.close();
  });
});
