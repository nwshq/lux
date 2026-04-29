// Tests for the tranche-one feature-path failure classification and
// rendering rules.
//
// Each test isolates one rule so a regression in classification can be
// pinpointed without rebuilding a full answer state. The rendering tests pin
// the output shape for text rendering.

import { describe, it, expect } from 'vitest';
import {
  classifyFeaturePathFailures,
  renderFeaturePathFailures,
  withClassifiedFailures,
  WEAK_EVIDENCE_TRUST_TIER,
  WEAK_OWNERSHIP_TRUST_TIER,
} from '../failures.js';
import type {
  FeaturePathAnswer,
  FeaturePathContracts,
  FeaturePathCrossLanguage,
  FeaturePathDirectEvidenceItem,
  FeaturePathOwnership,
  FeaturePathResolution,
  FeaturePathTarget,
} from '../contract.js';
import { FEATURE_PATH_ANSWER_SCHEMA_VERSION } from '../contract.js';
import { provenRouteHandlerAnswer } from '../__fixtures__/proven-answer.js';

const baseTarget: FeaturePathTarget = {
  kind: 'route-surface',
  id: 'surface:http:POST:/offers',
  label: 'POST /offers',
  trustTier: 5,
};

const baseResolution: FeaturePathResolution = {
  query: 'POST /offers',
  status: 'resolved',
  matchedBy: 'semantic-exact',
  candidates: [baseTarget],
};

const strongOwnership: FeaturePathOwnership = {
  regionId: 'module:Listings',
  regionName: 'Listings',
  basis: 'module-boundary',
  trustTier: 5,
};

const strongContracts: FeaturePathContracts = {
  request: { label: 'exact(StoreOfferRequest)', shapeConfidence: 'exact' },
  response: { label: 'exact(OfferResource)', shapeConfidence: 'exact' },
};

const handlerEvidence: FeaturePathDirectEvidenceItem = {
  kind: 'handler-recovery',
  description: 'OfferController@store',
  trustTier: 5,
};

const refusedNamingOnlyCrossLanguage: FeaturePathCrossLanguage = {
  status: 'refused-naming-only',
  associations: [],
  rationale: 'Only a naming-based association exists.',
};

describe('classifyFeaturePathFailures', () => {
  it('flags unresolved-target when resolution did not produce a target', () => {
    const failures = classifyFeaturePathFailures({
      intent: 'route-handler',
      resolution: { query: 'no-such-route', status: 'unresolved', candidates: [] },
      target: null,
      ownership: null,
      contracts: null,
      directEvidence: [],
      crossLanguage: null,
    });
    const classes = failures.map((f) => f.failureClass);
    expect(classes).toContain('unresolved-target');
  });

  it('flags ambiguous-target when multiple candidates matched', () => {
    const failures = classifyFeaturePathFailures({
      intent: 'route-handler',
      resolution: {
        query: 'POST /offers',
        status: 'ambiguous',
        candidates: [baseTarget, { ...baseTarget, id: 'surface:http:POST:/offers/internal' }],
      },
      target: null,
      ownership: null,
      contracts: null,
      directEvidence: [],
      crossLanguage: null,
    });
    expect(failures.map((f) => f.failureClass)).toContain('ambiguous-target');
  });

  it('flags missing-handler-recovery when route surface resolves but no handler evidence exists', () => {
    const failures = classifyFeaturePathFailures({
      intent: 'route-handler',
      resolution: baseResolution,
      target: baseTarget,
      ownership: strongOwnership,
      contracts: null,
      directEvidence: [
        {
          kind: 'route-declaration',
          description: 'route declared',
          trustTier: 5,
        },
      ],
      crossLanguage: null,
    });
    expect(failures.map((f) => f.failureClass)).toContain('missing-handler-recovery');
  });

  it('does not flag missing-handler-recovery when an event-listener registration is present', () => {
    const failures = classifyFeaturePathFailures({
      intent: 'route-handler',
      resolution: baseResolution,
      target: baseTarget,
      ownership: strongOwnership,
      contracts: null,
      directEvidence: [
        {
          kind: 'event-listener-registration',
          description: 'listener attached',
          trustTier: 5,
        },
      ],
      crossLanguage: null,
    });
    expect(failures.map((f) => f.failureClass)).not.toContain('missing-handler-recovery');
  });

  it('flags weak-ownership when ownership is null', () => {
    const failures = classifyFeaturePathFailures({
      intent: 'route-ownership',
      resolution: baseResolution,
      target: baseTarget,
      ownership: null,
      contracts: null,
      directEvidence: [handlerEvidence],
      crossLanguage: null,
    });
    expect(failures.map((f) => f.failureClass)).toContain('weak-ownership');
  });

  it('flags weak-ownership when trustTier is at or below the threshold', () => {
    const weak: FeaturePathOwnership = {
      ...strongOwnership,
      trustTier: WEAK_OWNERSHIP_TRUST_TIER,
    };
    const failures = classifyFeaturePathFailures({
      intent: 'route-ownership',
      resolution: baseResolution,
      target: baseTarget,
      ownership: weak,
      contracts: null,
      directEvidence: [handlerEvidence],
      crossLanguage: null,
    });
    expect(failures.map((f) => f.failureClass)).toContain('weak-ownership');
  });

  it('does not flag weak-ownership for a strong module-boundary attribution', () => {
    const failures = classifyFeaturePathFailures({
      intent: 'route-ownership',
      resolution: baseResolution,
      target: baseTarget,
      ownership: strongOwnership,
      contracts: null,
      directEvidence: [handlerEvidence],
      crossLanguage: null,
    });
    expect(failures.map((f) => f.failureClass)).not.toContain('weak-ownership');
  });

  it('flags insufficient-contract-recovery for route-contract intent without contracts', () => {
    const failures = classifyFeaturePathFailures({
      intent: 'route-contract',
      resolution: baseResolution,
      target: baseTarget,
      ownership: strongOwnership,
      contracts: null,
      directEvidence: [handlerEvidence],
      crossLanguage: null,
    });
    expect(failures.map((f) => f.failureClass)).toContain('insufficient-contract-recovery');
  });

  it('does not flag insufficient-contract-recovery when intent is not route-contract', () => {
    const failures = classifyFeaturePathFailures({
      intent: 'route-handler',
      resolution: baseResolution,
      target: baseTarget,
      ownership: strongOwnership,
      contracts: null,
      directEvidence: [handlerEvidence],
      crossLanguage: null,
    });
    expect(failures.map((f) => f.failureClass)).not.toContain('insufficient-contract-recovery');
  });

  it('does not flag insufficient-contract-recovery when at least one contract was recovered', () => {
    const failures = classifyFeaturePathFailures({
      intent: 'route-contract',
      resolution: baseResolution,
      target: baseTarget,
      ownership: strongOwnership,
      contracts: strongContracts,
      directEvidence: [handlerEvidence],
      crossLanguage: null,
    });
    expect(failures.map((f) => f.failureClass)).not.toContain('insufficient-contract-recovery');
  });

  it('flags insufficient-direct-evidence when directEvidence is empty', () => {
    const failures = classifyFeaturePathFailures({
      intent: 'route-handler',
      resolution: baseResolution,
      target: baseTarget,
      ownership: strongOwnership,
      contracts: null,
      directEvidence: [],
      crossLanguage: null,
    });
    expect(failures.map((f) => f.failureClass)).toContain('insufficient-direct-evidence');
  });

  it('flags insufficient-direct-evidence when every item is at or below the weak-trust floor', () => {
    const failures = classifyFeaturePathFailures({
      intent: 'route-handler',
      resolution: baseResolution,
      target: baseTarget,
      ownership: strongOwnership,
      contracts: null,
      directEvidence: [
        {
          kind: 'handler-recovery',
          description: 'low-trust handler hit',
          trustTier: WEAK_EVIDENCE_TRUST_TIER,
        },
      ],
      crossLanguage: null,
    });
    expect(failures.map((f) => f.failureClass)).toContain('insufficient-direct-evidence');
  });

  it('flags insufficient-direct-evidence when only a route declaration exists', () => {
    const failures = classifyFeaturePathFailures({
      intent: 'route-handler',
      resolution: baseResolution,
      target: baseTarget,
      ownership: strongOwnership,
      contracts: null,
      directEvidence: [
        {
          kind: 'route-declaration',
          description: 'route declared',
          trustTier: 5,
        },
      ],
      crossLanguage: null,
    });
    // missing-handler-recovery and insufficient-direct-evidence both apply.
    expect(failures.map((f) => f.failureClass)).toContain('insufficient-direct-evidence');
  });

  it('flags cross-language-below-promotion-threshold when crossLanguage is refused', () => {
    const failures = classifyFeaturePathFailures({
      intent: 'route-handler',
      resolution: baseResolution,
      target: baseTarget,
      ownership: strongOwnership,
      contracts: null,
      directEvidence: [handlerEvidence],
      crossLanguage: refusedNamingOnlyCrossLanguage,
    });
    expect(failures.map((f) => f.failureClass)).toContain(
      'cross-language-below-promotion-threshold'
    );
  });

  it('does not flag cross-language failures when status is promoted', () => {
    const promoted: FeaturePathCrossLanguage = {
      status: 'promoted',
      trustTier: 4,
      associations: [
        {
          backendNodeId: 'b',
          frontendNodeId: 'f',
          basis: 'generated-types',
          trustTier: 4,
        },
      ],
    };
    const failures = classifyFeaturePathFailures({
      intent: 'route-handler',
      resolution: baseResolution,
      target: baseTarget,
      ownership: strongOwnership,
      contracts: null,
      directEvidence: [handlerEvidence],
      crossLanguage: promoted,
    });
    expect(failures.map((f) => f.failureClass)).not.toContain(
      'cross-language-below-promotion-threshold'
    );
  });
});

describe('renderFeaturePathFailures', () => {
  it('renders nothing when there are no failures', () => {
    expect(renderFeaturePathFailures([])).toEqual([]);
  });

  it('renders a Failures header followed by one line per failure', () => {
    const lines = renderFeaturePathFailures([
      { failureClass: 'unresolved-target', detail: 'no match for foo' },
      {
        failureClass: 'cross-language-below-promotion-threshold',
        detail: 'naming only',
      },
    ]);
    expect(lines[0]).toBe('');
    expect(lines[1]).toBe('Failures');
    expect(lines[2]).toBe('- Unresolved target: no match for foo');
    expect(lines[3]).toBe('- Cross-language below promotion threshold: naming only');
  });
});

describe('withClassifiedFailures', () => {
  it('replaces the failures array with the result of classification', () => {
    const blank: FeaturePathAnswer = {
      ...provenRouteHandlerAnswer,
      schemaVersion: FEATURE_PATH_ANSWER_SCHEMA_VERSION,
      failures: [],
    };
    const reclassified = withClassifiedFailures(blank);
    // The fixture has a refused-naming-only cross-language section, so this
    // failure must reappear after classification.
    expect(reclassified.failures.map((f) => f.failureClass)).toContain(
      'cross-language-below-promotion-threshold'
    );
    // Original answer object is not mutated.
    expect(blank.failures).toEqual([]);
  });
});
