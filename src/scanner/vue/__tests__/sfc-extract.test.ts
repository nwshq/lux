import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type Parser from 'web-tree-sitter';
import { initGrammars, type AstLang } from '../../ast/extract.js';
import { extractVueSfc } from '../sfc-extract.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'components');
let grammars: Map<AstLang, Parser.Language>;

beforeAll(async () => {
  grammars = await initGrammars();
});

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

describe('extractVueSfc', () => {
  it('maps both script blocks and extracts the later resolver facts', async () => {
    const facts = await extractVueSfc(fixture('Parent.vue'), 'src/Parent.vue', { grammars });
    expect(facts.componentId).toBe('component:vue:src%2FParent.vue');
    expect(facts.imports.map((item) => item.localName)).toEqual([
      'LegacyChild',
      'defineComponent',
      'SetupChild',
      'aliasedThing',
    ]);
    expect(facts.optionsComponents).toEqual({ LegacyChild: 'LegacyChild', Alias: 'LegacyChild' });
    expect(facts.calls.find((item) => item.callee === 'aliasedThing')).toMatchObject({
      localBinding: 'aliasedThing',
      firstStaticString: 'static',
      location: { filePath: 'src/Parent.vue', line: 12, column: 12 },
    });
    expect(facts.references.find((item) => item.rawTarget === './Child.vue')?.location).toEqual({
      filePath: 'src/Parent.vue',
      line: 2,
      column: 7,
    });
    expect(facts.events.map((item) => `${item.source}:${item.eventName}`)).toEqual(
      expect.arrayContaining([
        'options-emits:ready',
        'defineEmits:saved',
        'defineEmits:changed',
        'emit-call:saved',
      ])
    );
  });

  it('extracts only static component targets and child-scoped listeners', async () => {
    const facts = await extractVueSfc(fixture('Parent.vue'), 'src/Parent.vue', { grammars });
    expect(facts.templateElements).toEqual([
      expect.objectContaining({
        tag: 'setup-child',
        location: expect.objectContaining({ line: 18 }),
      }),
      expect.objectContaining({ tag: 'Alias' }),
      expect.objectContaining({ tag: 'component', staticIs: 'LegacyChild' }),
      expect.objectContaining({ tag: 'LegacyChild' }),
    ]);
    expect(facts.templateListeners).toEqual([
      expect.objectContaining({ childTag: 'setup-child', eventName: 'saved', handler: 'onSaved' }),
      expect.objectContaining({
        childTag: 'setup-child',
        eventName: 'update:amount',
        modelArgument: 'amount',
      }),
      expect.objectContaining({ childTag: 'Alias', eventName: 'ready' }),
    ]);
    expect(facts.diagnostics.some((item) => item.code === 'vue-dynamic-component')).toBe(true);
  });

  it('retains literal async imports while diagnosing every dynamic false-edge form', async () => {
    const facts = await extractVueSfc(fixture('Dynamic.vue'), 'src/Dynamic.vue', { grammars });
    expect(facts.imports.find((item) => item.localName === 'Lazy')).toMatchObject({
      specifier: './Child.vue',
      importedName: 'default',
    });
    expect(facts.templateElements.map((item) => item.tag)).toEqual(['Lazy', 'Unused']);
    expect(facts.templateListeners).toEqual([]);
    expect(facts.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'vue-async-component-dynamic',
        'vue-dynamic-component',
        'vue-object-listener',
        'vue-dynamic-event',
        'vue-dynamic-model',
      ])
    );
  });

  it('copies compiler recovery errors while retaining safe partial facts', async () => {
    const source =
      '<template><Child><span></template><script setup>import Child from "./Child.vue"</script>';
    const facts = await extractVueSfc(source, 'src/Malformed.vue', { grammars });
    expect(facts.compilerDiagnostics.length).toBeGreaterThan(0);
    expect(facts.diagnostics.length).toBeGreaterThan(0);
    expect(facts.imports[0]).toMatchObject({ localName: 'Child', specifier: './Child.vue' });
  });

  it('rejects unsafe paths and enforces byte, node, depth, and reference limits', async () => {
    const source = fixture('Parent.vue');
    expect((await extractVueSfc(source, '../escape.vue', { grammars })).diagnostics[0]?.code).toBe(
      'path-escape'
    );
    expect(
      (await extractVueSfc(source, 'src/Large.vue', { grammars, limits: { maxBytes: 1 } }))
        .diagnostics[0]?.code
    ).toBe('limit');
    for (const limits of [
      { maxNodes: 1 },
      { maxDepth: 1 },
      { maxReferences: 1 },
      { timeoutMs: 0 },
      { maxResultBytes: 1 },
    ]) {
      const facts = await extractVueSfc(source, 'src/Limited.vue', { grammars, limits });
      expect(
        facts.diagnostics.some((item) => item.code === 'limit' || item.code === 'timeout')
      ).toBe(true);
    }
  });

  it('does not read external script/template blocks or consume preprocessors', async () => {
    const source = `<script src="./external.ts"></script>
<template lang="pug" src="./view.pug"></template>`;
    const facts = await extractVueSfc(source, 'src/External.vue', { grammars });
    expect(facts.imports).toEqual([]);
    expect(facts.templateElements).toEqual([]);
    expect(facts.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['vue-script-src-unsupported', 'vue-template-src-unsupported'])
    );
  });

  it('is deterministic when the optional LSP seam is off or on', async () => {
    const source = fixture('Parent.vue');
    const off = await extractVueSfc(source, 'src/Parent.vue', { grammars, lspEnabled: false });
    const on = await extractVueSfc(source, 'src/Parent.vue', { grammars, lspEnabled: true });
    expect(on).toEqual(off);
  });

  it('refuses disagreeing duplicate imports rather than selecting one', async () => {
    const source = `<script>import Child from './A.vue'</script>\n<script setup>import Child from './B.vue'</script>\n<template><Child /></template>`;
    const facts = await extractVueSfc(source, 'src/Ambiguous.vue', { grammars });
    expect(facts.imports.some((item) => item.localName === 'Child')).toBe(false);
    expect(facts.diagnostics.some((item) => item.code === 'vue-import-ambiguous')).toBe(true);
  });
});
