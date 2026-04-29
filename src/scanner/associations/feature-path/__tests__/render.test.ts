// Tests for tranche-one feature-path official renderers.
//
// These tests pin the invariant that direct evidence and context are presented
// under separate sections in every official output (T7, R5, R6).

import { describe, it, expect } from 'vitest';
import { provenRouteHandlerAnswer } from '../__fixtures__/proven-answer.js';
import { FEATURE_PATH_ANSWER_SCHEMA_VERSION, type FeaturePathAnswer } from '../contract.js';
import { renderFeaturePathAnswerJson, renderFeaturePathAnswerText } from '../render.js';

function unresolvedAnswer(): FeaturePathAnswer {
  return {
    schemaVersion: FEATURE_PATH_ANSWER_SCHEMA_VERSION,
    question: 'what handles GET /missing?',
    intent: 'route-handler',
    overlayTrustLevel: 'overlay-complete',
    resolution: {
      query: 'GET /missing',
      status: 'unresolved',
      candidates: [],
    },
    target: null,
    primaryAnswer: {
      summary: 'Lux could not resolve the question to a feature-path target.',
      confidence: 'none',
    },
    ownership: null,
    contracts: null,
    directEvidence: [],
    context: [],
    downstreamStep: null,
    crossLanguage: null,
    trust: {
      targetTrustTier: null,
      evidenceTrustTiers: [],
      ownershipTrustTier: null,
      mixedTrust: false,
    },
    failures: [
      {
        failureClass: 'unresolved-target',
        detail: 'Lux could not resolve "GET /missing" to a persisted feature-path target.',
      },
    ],
  };
}

describe('renderFeaturePathAnswerText', () => {
  it('renders direct evidence and context under separate, clearly-labeled sections', () => {
    const text = renderFeaturePathAnswerText(provenRouteHandlerAnswer);
    const directIdx = text.indexOf('Direct evidence');
    const contextIdx = text.indexOf('Context');
    expect(directIdx).toBeGreaterThan(-1);
    expect(contextIdx).toBeGreaterThan(-1);
    expect(directIdx).toBeLessThan(contextIdx);
  });

  it('emits "none recovered" under Direct evidence even when there is none', () => {
    const text = renderFeaturePathAnswerText(unresolvedAnswer());
    const directIdx = text.indexOf('Direct evidence');
    expect(directIdx).toBeGreaterThan(-1);
    expect(text.slice(directIdx)).toContain('none recovered');
  });

  it('omits the Context section entirely when no context items exist', () => {
    const text = renderFeaturePathAnswerText(unresolvedAnswer());
    expect(text).not.toContain('\nContext\n');
  });

  it('does not present any context item under the Direct evidence section', () => {
    const text = renderFeaturePathAnswerText(provenRouteHandlerAnswer);
    const directIdx = text.indexOf('Direct evidence');
    const contextIdx = text.indexOf('\nContext');
    const directBlock = text.slice(directIdx, contextIdx > -1 ? contextIdx : undefined);
    for (const item of provenRouteHandlerAnswer.context) {
      expect(directBlock).not.toContain(item.description);
    }
  });

  it('renders failures after both direct evidence and context sections', () => {
    const text = renderFeaturePathAnswerText(unresolvedAnswer());
    const directIdx = text.indexOf('Direct evidence');
    const failuresIdx = text.indexOf('Failures');
    expect(directIdx).toBeGreaterThan(-1);
    expect(failuresIdx).toBeGreaterThan(-1);
    expect(directIdx).toBeLessThan(failuresIdx);
  });

  it('renders the primary answer summary on the first line', () => {
    const text = renderFeaturePathAnswerText(provenRouteHandlerAnswer);
    const firstLine = text.split('\n')[0];
    expect(firstLine).toBe(provenRouteHandlerAnswer.primaryAnswer.summary);
  });

  it('renders ownership when present', () => {
    const text = renderFeaturePathAnswerText(provenRouteHandlerAnswer);
    expect(text).toContain('Ownership');
    expect(text).toContain(provenRouteHandlerAnswer.ownership!.regionName);
  });

  it('omits the Ownership section entirely when ownership is null', () => {
    const text = renderFeaturePathAnswerText(unresolvedAnswer());
    expect(text).not.toContain('\nOwnership\n');
  });
});

describe('renderFeaturePathAnswerJson', () => {
  it('round-trips the answer object losslessly', () => {
    const json = renderFeaturePathAnswerJson(provenRouteHandlerAnswer);
    const parsed = JSON.parse(json);
    expect(parsed.schemaVersion).toBe(FEATURE_PATH_ANSWER_SCHEMA_VERSION);
    expect(parsed.directEvidence).toHaveLength(provenRouteHandlerAnswer.directEvidence.length);
    expect(parsed.context).toHaveLength(provenRouteHandlerAnswer.context.length);
  });

  it('keeps directEvidence and context as separate top-level arrays', () => {
    const json = renderFeaturePathAnswerJson(provenRouteHandlerAnswer);
    const parsed = JSON.parse(json) as FeaturePathAnswer;
    const directNodeIds = new Set(parsed.directEvidence.map((item) => item.nodeId));
    for (const contextItem of parsed.context) {
      if (contextItem.nodeId) {
        expect(directNodeIds.has(contextItem.nodeId)).toBe(false);
      }
    }
  });
});
