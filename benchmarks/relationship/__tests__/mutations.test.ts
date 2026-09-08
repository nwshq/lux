import { describe, expect, it } from 'vitest';
import { mutationAccepted, type Tranche3MutationKind } from '../mutations/tranche-3.js';
describe('Tranche3 mutation gate', () => {
  it('requires baseline, intended red, restoration and failed check', () => {
    const kind: Tranche3MutationKind = 'remove-jsx-use',
      mutation = {
        id: 'm',
        corpus: 'synthetic' as const,
        kind,
        files: ['a.tsx'],
        expectedFailedChecks: ['recall'],
      };
    expect(
      mutationAccepted({
        mutation,
        baselinePassed: true,
        mutationFailedAsExpected: true,
        restoredPassed: true,
        failedChecks: ['recall'],
        observedDiagnostics: [],
      })
    ).toBe(true);
    expect(
      mutationAccepted({
        mutation,
        baselinePassed: true,
        mutationFailedAsExpected: false,
        restoredPassed: true,
        failedChecks: [],
        observedDiagnostics: [],
      })
    ).toBe(false);
  });
});
