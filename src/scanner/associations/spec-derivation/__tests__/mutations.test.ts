import { describe, expect, it } from 'vitest';
import { classifyDecisionClaimType, classifyMutationKind } from '../mutations.js';

describe('spec-derivation mutation classifiers', () => {
  it('maps dispatch evidence onto the generic mutation taxonomy', () => {
    expect(classifyMutationKind('Controller dispatches App\\Jobs\\SyncOrders')).toBe(
      'job_dispatch'
    );
  });

  it('keeps unknown side effects explicit', () => {
    expect(classifyMutationKind('Handler performs custom work')).toBe('unknown_side_effect');
  });

  it('classifies common decision logic without authoring business rules', () => {
    expect(classifyDecisionClaimType('Request validation is attached')).toBe('validation');
    expect(classifyDecisionClaimType('Policy authorization check')).toBe('authorization');
  });
});
