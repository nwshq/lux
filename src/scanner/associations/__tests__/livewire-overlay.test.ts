import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LuxDatabase } from '../../../db/index.js';
import type { ScanResult } from '../../types.js';
import { bladeTemplateId } from '../../identity/program-identity.js';
import { phpSymbolNodeId } from '../types.js';
import { rebuildStructuralOverlay } from '../overlay-service.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Phase 13 Livewire overlay integration', () => {
  it('materializes Blade templates before storing canonical bridge edges', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lux-livewire-overlay-'));
    roots.push(root);
    const files = {
      'app/Livewire/WelcomePanel.php': `<?php
namespace App\\Livewire;
use Livewire\\Component;
class WelcomePanel extends Component {
  public function render() { return view('livewire.welcome-panel'); }
}`,
      'resources/views/livewire/welcome-panel.blade.php': '<div>Welcome</div>',
      'resources/views/pages/dashboard.blade.php': '<livewire:welcome-panel />',
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
      detectors: [],
      operationalExtractors: [],
    });

    const component = phpSymbolNodeId('App\\Livewire\\WelcomePanel');
    const componentView = bladeTemplateId('resources/views/livewire/welcome-panel.blade.php');
    const parentView = bladeTemplateId('resources/views/pages/dashboard.blade.php');
    expect(db.getStructuralNode(componentView)).toMatchObject({
      node_type: 'template',
      language_id: 'blade',
    });
    expect(db.getStructuralNode(parentView)).toMatchObject({
      node_type: 'template',
      language_id: 'blade',
    });
    expect(db.getOutgoingStructuralEdges(component)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ edge_type: 'renders_template', target_node_id: componentView }),
      ])
    );
    expect(db.getOutgoingStructuralEdges(parentView)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ edge_type: 'hydrates_component', target_node_id: component }),
      ])
    );
    db.close();
  });
});
