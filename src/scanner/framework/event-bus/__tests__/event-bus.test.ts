import { describe, expect, it } from 'vitest';
import { resolveEventBus } from '../resolver.js';
describe('EventBus graph', () => {
  it('scopes literal events by bus identity', () => {
    const l = { filePath: 'bus.ts', line: 1, column: 0 },
      catalog = [
        {
          busId: 'app',
          declarationFile: 'bus.ts',
          exportName: 'bus',
          eventKeys: ['ready'],
          methods: { publish: ['emit'], subscribe: ['on'] },
          evidence: [l],
        },
        {
          busId: 'other',
          declarationFile: 'other.ts',
          exportName: 'bus',
          eventKeys: ['ready'],
          methods: { publish: ['emit'], subscribe: ['on'] },
          evidence: [l],
        },
      ],
      calls = catalog.map((b, i) => ({
        kind: 'event-bus-call' as const,
        filePath: `owner${i}.ts`,
        ownerExport: 'run',
        busId: b.busId,
        method: 'emit',
        operation: 'publish' as const,
        eventKey: 'ready',
        location: l,
      })),
      out = resolveEventBus(calls, catalog);
    expect(out.nodes).toHaveLength(2);
    expect(new Set(out.nodes.map((n) => n.id)).size).toBe(2);
    expect(out.edges).toHaveLength(2);
  });
  it('emits nothing for computed or unknown calls', () =>
    expect(
      resolveEventBus(
        [
          {
            kind: 'event-bus-call',
            filePath: 'a.ts',
            ownerExport: 'run',
            method: 'emit',
            operation: 'publish',
            location: { filePath: 'a.ts', line: 1, column: 0 },
          },
        ],
        []
      ).edges
    ).toEqual([]));
});
