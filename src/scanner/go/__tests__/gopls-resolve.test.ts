import { describe, expect, it } from 'vitest';
import { resolveGoSemanticQueries } from '../gopls-resolve.js';
describe('gopls confinement', () =>
  it('preserves deterministic output and refuses outside targets', async () => {
    const project: any = { corpusRoot: '/repo' },
      q = [{ filePath: 'a.go', line: 1, character: 1, sourceId: 's', edgeType: 'calls' as const }],
      ok = await resolveGoSemanticQueries(project, q, {
        resolveDefinition: () => Promise.resolve({ filePath: '/repo/b.go', line: 2 }),
      }),
      bad = await resolveGoSemanticQueries(project, q, {
        resolveDefinition: () => Promise.resolve({ filePath: '/outside/b.go', line: 2 }),
      });
    expect(ok.definitions).toHaveLength(1);
    expect(bad.definitions).toEqual([]);
    expect(bad.diagnostics[0].code).toBe('target-outside-root');
  }));
