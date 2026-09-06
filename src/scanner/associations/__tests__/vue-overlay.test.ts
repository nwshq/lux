import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LuxDatabase } from '../../../db/index.js';
import type { ScanResult } from '../../types.js';
import { vueComponentId } from '../../identity/program-identity.js';
import { rebuildStructuralOverlay } from '../overlay-service.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Phase 9 Vue overlay integration', () => {
  it('materializes components before storing deterministic render edges', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lux-vue-overlay-'));
    roots.push(root);
    mkdirSync(join(root, 'src'));
    const files = {
      'src/Parent.vue': `<script setup>\nimport Child from './Child.vue'\n</script>\n<template><Child /></template>`,
      'src/Child.vue': `<template><div>child</div></template>`,
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
    const result = await rebuildStructuralOverlay(db, root, { knowledge }, new Map(), {
      astEnabled: true,
      detectors: [],
      operationalExtractors: [],
    });
    expect(db.getStructuralNode(vueComponentId('src/Parent.vue'))).toMatchObject({
      language_id: 'vue',
      symbol_kind: 'VueComponent',
    });
    expect(db.getStructuralNode(vueComponentId('src/Child.vue'))).not.toBeNull();
    expect(db.getOutgoingStructuralEdges(vueComponentId('src/Parent.vue'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edge_type: 'renders_component',
          target_node_id: vueComponentId('src/Child.vue'),
        }),
      ])
    );
    expect(result.programAnalysis?.producersRun.has('vue-compiler-sfc')).toBe(true);
    db.close();
  });
});
