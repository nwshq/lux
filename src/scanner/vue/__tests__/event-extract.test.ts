import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractVueEvents } from '../event-extract.js';

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/events/${name}.vue`, import.meta.url)),
    'utf8'
  );
}

describe('extractVueEvents', () => {
  it('extracts all supported static declarations, scoped calls, and template listeners', () => {
    const result = extractVueEvents(fixture('accepted'), 'src/Accepted.vue');
    const events = result.events.map((event) => `${event.source}:${event.eventName}`);

    expect(new Set(events)).toEqual(
      new Set([
        'options-emits:option-array-a',
        'options-emits:option-array-b',
        'emit-call:option-call-a',
        'emit-call:option-call-b',
        'emit-call:setup-destructure-alias',
        'emit-call:setup-destructure-nested',
        'defineEmits:runtime-array-a',
        'defineEmits:runtime-array-b',
        'defineEmits:runtime-object-quoted',
        'defineEmits:runtimeObjectIdentifier',
        'defineEmits:typed-call-a',
        'defineEmits:typed-call-b',
        'defineEmits:typed-call-c',
        'defineEmits:typedProperty',
        'defineEmits:typed-quoted-property',
        'emit-call:bound-call-a',
        'emit-call:bound-call-b',
        'emit-call:bound-call-c',
        'emit-call:bound-call-d',
        'model:update:modelValue',
        'model:update:amount',
      ])
    );
    expect(result.listeners.map((listener) => listener.eventName)).toEqual([
      'saved',
      'changed',
      'update:modelValue',
      'update:amount',
      'update:legacy',
    ]);
    expect(events).toHaveLength(21);
    expect(result.listeners).toHaveLength(5);
    expect(result.diagnostics).toEqual([]);
  });

  it('refuses dynamic, spread, computed, and shadowed forms', () => {
    const result = extractVueEvents(fixture('forbidden'), 'src/Forbidden.vue');

    expect(result.events.map((event) => `${event.source}:${event.eventName}`)).toEqual([
      'emit-call:established-context',
    ]);
    expect(result.listeners).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['vue-object-listener', 'vue-dynamic-event', 'vue-dynamic-model'])
    );
  });

  it('returns deterministic diagnostics for malformed scripts', () => {
    const result = extractVueEvents('<script setup>const =</script>', 'src/Broken.vue');
    expect(result.events).toEqual([]);
    expect(result.listeners).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe('vue-event-script-parse-error');
  });
});
