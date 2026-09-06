import { describe, expect, it } from 'vitest';
import { extractVueSfc } from '../sfc-extract.js';
import { VueComponentResolver } from '../component-resolver.js';

describe('Vue deterministic LSP parity', () => {
  it('preserves identical component facts and render edges with LSP off/on', async () => {
    const parentSource = `<script setup>\nimport Child from './Child.vue'\n</script>\n<template><Child /></template>`;
    const childSource = `<template><div>child</div></template>`;
    const off = [
      await extractVueSfc(parentSource, 'src/Parent.vue', { lspEnabled: false }),
      await extractVueSfc(childSource, 'src/Child.vue', { lspEnabled: false }),
    ];
    const on = [
      await extractVueSfc(parentSource, 'src/Parent.vue', { lspEnabled: true }),
      await extractVueSfc(childSource, 'src/Child.vue', { lspEnabled: true }),
    ];
    expect(on).toEqual(off);
    const project = {
      rootPath: '/repo',
      sourceFiles: new Set(['src/Parent.vue', 'src/Child.vue']),
      aliases: [],
      workspacePackages: [],
      exportsByFile: new Map(),
      fingerprintInputs: [],
    } as const;
    const resolver = new VueComponentResolver({ now: () => 1 });
    expect(await resolver.resolve(on, project)).toEqual(await resolver.resolve(off, project));
  });
});
