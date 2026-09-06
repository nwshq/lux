import { describe, expect, it } from 'vitest';
import { vueComponentEventId, vueComponentId } from '../../identity/program-identity.js';
import { VueEventResolver, type VueResolvedChildV1 } from '../event-resolver.js';
import type { VueSfcFactsV1 } from '../types.js';

const at = (filePath: string, line: number, column = 0) => ({ filePath, line, column });

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

describe('VueEventResolver', () => {
  it('materializes child-scoped event artifacts and matches the exact resolved child use', () => {
    const child = facts('src/Child.vue', {
      events: [
        { eventName: 'saved', source: 'defineEmits', location: at('src/Child.vue', 2) },
        { eventName: 'saved', source: 'emit-call', location: at('src/Child.vue', 5) },
        { eventName: 'update:modelValue', source: 'model', location: at('src/Child.vue', 3) },
      ],
    });
    const parent = facts('src/Parent.vue', {
      templateElements: [
        { tag: 'child-card', location: at('src/Parent.vue', 10, 2) },
        { tag: 'child-card', location: at('src/Parent.vue', 20, 2) },
      ],
      templateListeners: [
        { childTag: 'child-card', eventName: 'saved', location: at('src/Parent.vue', 10, 14) },
        {
          childTag: 'child-card',
          eventName: 'update:modelValue',
          location: at('src/Parent.vue', 10, 28),
        },
        { childTag: 'child-card', eventName: 'missing', location: at('src/Parent.vue', 10, 40) },
      ],
    });
    const resolved: VueResolvedChildV1[] = [
      {
        parentComponentId: parent.componentId,
        childComponentId: child.componentId,
        childTag: 'ChildCard',
        location: at('src/Parent.vue', 10, 2),
      },
    ];

    const result = new VueEventResolver({ now: () => 42 }).resolve([parent, child], resolved);
    expect(result.artifacts.map((artifact) => artifact.id)).toEqual([
      vueComponentEventId(child.componentId, 'saved'),
      vueComponentEventId(child.componentId, 'update:modelValue'),
    ]);
    expect(result.artifacts[0]?.declarations).toHaveLength(2);
    expect(result.edges.filter((edge) => edge.edgeType === 'emits_component_event')).toHaveLength(
      2
    );
    expect(result.edges.filter((edge) => edge.edgeType === 'handles_component_event')).toHaveLength(
      2
    );
    expect(result.edges.every((edge) => edge.provenance.extractedAt === 42)).toBe(true);
  });

  it('does not cross-match same-named events, unresolved uses, or ambiguous child resolutions', () => {
    const one = facts('src/One.vue', {
      events: [{ eventName: 'saved', source: 'defineEmits', location: at('src/One.vue', 1) }],
    });
    const two = facts('src/Two.vue', {
      events: [{ eventName: 'saved', source: 'defineEmits', location: at('src/Two.vue', 1) }],
    });
    const parent = facts('src/Parent.vue', {
      templateElements: [{ tag: 'child-card', location: at('src/Parent.vue', 4) }],
      templateListeners: [
        { childTag: 'child-card', eventName: 'saved', location: at('src/Parent.vue', 4, 10) },
      ],
    });
    const resolved = [one, two].map((child) => ({
      parentComponentId: parent.componentId,
      childComponentId: child.componentId,
      childTag: 'child-card',
      location: at('src/Parent.vue', 4),
    }));

    const result = new VueEventResolver({ now: () => 1 }).resolve([parent, one, two], resolved);
    expect(result.artifacts).toHaveLength(2);
    expect(result.edges.filter((edge) => edge.edgeType === 'handles_component_event')).toEqual([]);
  });

  it('rejects noncanonical and duplicate component facts deterministically', () => {
    const canonical = facts('src/Child.vue', {
      events: [{ eventName: 'saved', source: 'defineEmits', location: at('src/Child.vue', 1) }],
    });
    const forged = { ...facts('src/Forged.vue'), componentId: canonical.componentId };
    const duplicate = facts('src/Child.vue');

    expect(new VueEventResolver().resolve([canonical, duplicate, forged], []).artifacts).toEqual(
      []
    );
  });
});
