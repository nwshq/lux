import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LuxDatabase } from '../../../db/index.js';
import type { ScanResult } from '../../types.js';
import { vueComponentEventId, vueComponentId } from '../../identity/program-identity.js';
import { rebuildStructuralOverlay } from '../overlay-service.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Phase 11 Vue event overlay integration', () => {
  it('materializes child-scoped event artifacts before canonical edges', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lux-vue-event-overlay-'));
    roots.push(root);
    mkdirSync(join(root, 'src'));
    const files = {
      'src/Parent.vue': `<script setup>\nimport Child from './Child.vue'\n</script>\n<template><Child @saved="onSaved" /></template>`,
      'src/Child.vue': `<script setup>\nconst emit = defineEmits(['saved'])\nemit('saved')\n</script><template><button /></template>`,
    };
    const knowledge: ScanResult['knowledge'] = [];
    for (const [path, content] of Object.entries(files)) {
      const absolute = join(root, path);
      writeFileSync(absolute, content);
      knowledge.push({
        type: 'source-code',
        title: path,
        filePath: absolute,
        frontmatter: { language: 'vue', extension: '.vue' },
        content,
      });
    }
    const db = new LuxDatabase(join(root, 'lux.db'));
    await rebuildStructuralOverlay(db, root, { knowledge }, new Map(), {
      astEnabled: true,
      detectors: [],
      operationalExtractors: [],
    });
    const parent = vueComponentId('src/Parent.vue');
    const child = vueComponentId('src/Child.vue');
    const artifact = vueComponentEventId(child, 'saved');
    expect(db.getStructuralNode(artifact)).toMatchObject({
      node_type: 'artifact',
      language_id: 'vue',
      symbol_kind: 'VueComponentEvent',
    });
    expect(db.getOutgoingStructuralEdges(child)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ edge_type: 'emits_component_event', target_node_id: artifact }),
      ])
    );
    expect(db.getOutgoingStructuralEdges(parent)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ edge_type: 'handles_component_event', target_node_id: artifact }),
      ])
    );
    db.close();
  });
});
