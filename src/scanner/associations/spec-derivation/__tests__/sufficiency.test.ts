import { describe, expect, it } from 'vitest';
import { buildSpecEvidenceClaim } from '../evidence.js';
import { classifySpecDerivationSufficiency } from '../sufficiency.js';

const resolvedTarget = {
  kind: 'route' as const,
  identifier: 'POST /orders',
  resolutionState: 'resolved' as const,
  resolvedNodeId: 'surface:http:POST:/orders',
  candidates: [],
};

describe('spec-derivation sufficiency', () => {
  it('requires at least one direct core evidence track', () => {
    const result = classifySpecDerivationSufficiency({
      target: resolvedTarget,
      stateChanges: [],
      decisionLogic: [],
      dataFlow: [],
      operationalEffects: [],
      supportingContext: [],
    });

    expect(result.overall).toBe('insufficient');
    expect(result.canSupportSpecDraft).toBe(false);
    expect(result.missingEvidence.length).toBeGreaterThan(0);
  });

  it('marks partial when direct evidence exists but tracks are missing', () => {
    const claim = buildSpecEvidenceClaim({
      claimType: 'handler',
      sourceFact: 'POST /orders is handled by OrderController@store.',
      support: 'direct',
      evidence: [{ kind: 'symbol', summary: 'handler edge', evidenceStrength: 'direct' }],
    });

    const result = classifySpecDerivationSufficiency({
      target: resolvedTarget,
      stateChanges: [],
      decisionLogic: [],
      dataFlow: [],
      operationalEffects: [claim],
      supportingContext: [],
    });

    expect(result.overall).toBe('partial');
    expect(result.canSupportSpecDraft).toBe(true);
  });

  it('marks conflicting when any evidence claim is conflicting', () => {
    const claim = buildSpecEvidenceClaim({
      claimType: 'state_guard',
      sourceFact: 'Two source paths enforce incompatible order status guards.',
      support: 'conflicting',
      evidence: [
        { kind: 'symbol', summary: 'OrderController@store guard', evidenceStrength: 'direct' },
      ],
    });

    const result = classifySpecDerivationSufficiency({
      target: resolvedTarget,
      stateChanges: [],
      decisionLogic: [claim],
      dataFlow: [],
      operationalEffects: [],
      supportingContext: [],
    });

    expect(result.overall).toBe('conflicting');
    expect(result.canSupportSpecDraft).toBe(false);
    expect(result.conflictingEvidence).toContain(
      'Two source paths enforce incompatible order status guards.'
    );
  });
});
