// Contract-level tests for the tranche-one FeaturePathAnswer shape.
//
// These tests pin the answer-contract surface to its locked shape:
//   - the JSON Schema parses and matches the documented schemaVersion
//   - the JSON Schema's top-level required fields match the TypeScript interface
//   - the canonical proven-answer fixture conforms to the contract

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  FEATURE_PATH_ANSWER_SCHEMA_VERSION,
  FEATURE_PATH_INTENTS,
  FEATURE_PATH_FAILURE_CLASSES,
} from '../contract.js';
import { provenRouteHandlerAnswer } from '../__fixtures__/proven-answer.js';

const SCHEMA_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'schemas',
  'feature-path-answer.schema.json'
);

interface FeaturePathAnswerSchema {
  required: string[];
  properties: {
    schemaVersion: { const: number };
  };
  definitions: {
    featurePathIntent: { enum: string[] };
    failureClass: { enum: string[] };
    resolutionMatchType: { enum: string[] };
    failure: { required: string[] };
  };
}

function loadSchema(): FeaturePathAnswerSchema {
  const raw = readFileSync(SCHEMA_PATH, 'utf-8');
  return JSON.parse(raw) as FeaturePathAnswerSchema;
}

describe('FeaturePathAnswer contract', () => {
  it('JSON Schema parses and pins the same schemaVersion as the TypeScript const', () => {
    const schema = loadSchema();
    expect(schema.properties.schemaVersion.const).toBe(FEATURE_PATH_ANSWER_SCHEMA_VERSION);
  });

  it('JSON Schema top-level required fields match the locked tranche-one shape', () => {
    const schema = loadSchema();
    expect([...schema.required].sort()).toEqual(
      [
        'schemaVersion',
        'question',
        'intent',
        'overlayTrustLevel',
        'resolution',
        'target',
        'primaryAnswer',
        'ownership',
        'contracts',
        'directEvidence',
        'context',
        'downstreamStep',
        'crossLanguage',
        'trust',
        'failures',
      ].sort()
    );
  });

  it('JSON Schema intent enum matches the exported intent list', () => {
    const schema = loadSchema();
    expect([...schema.definitions.featurePathIntent.enum].sort()).toEqual(
      [...FEATURE_PATH_INTENTS].sort()
    );
  });

  it('JSON Schema failure-class enum matches the exported failure-class list', () => {
    const schema = loadSchema();
    expect([...schema.definitions.failureClass.enum].sort()).toEqual(
      [...FEATURE_PATH_FAILURE_CLASSES].sort()
    );
  });

  it('JSON Schema resolutionMatchType includes the four documented variants', () => {
    const schema = loadSchema();
    expect([...schema.definitions.resolutionMatchType.enum].sort()).toEqual(
      ['contains', 'exact', 'prefix', 'semantic-exact'].sort()
    );
  });
});

describe('proven-answer fixture', () => {
  it('compiles against the contract and uses the locked schemaVersion', () => {
    expect(provenRouteHandlerAnswer.schemaVersion).toBe(FEATURE_PATH_ANSWER_SCHEMA_VERSION);
  });

  it('keeps direct evidence and context separated', () => {
    const directKinds = new Set(provenRouteHandlerAnswer.directEvidence.map((item) => item.kind));
    const contextKinds = new Set(provenRouteHandlerAnswer.context.map((item) => item.kind));
    for (const kind of directKinds) {
      expect(contextKinds.has(kind as unknown as never)).toBe(false);
    }
  });

  it('records cross-language refusal honestly when the basis is naming-only', () => {
    expect(provenRouteHandlerAnswer.crossLanguage?.status).toBe('refused-naming-only');
    expect(
      provenRouteHandlerAnswer.crossLanguage?.associations.every(
        (assoc) => assoc.basis === 'naming-only'
      )
    ).toBe(true);
    expect(provenRouteHandlerAnswer.crossLanguage?.rationale).toBeTruthy();
  });

  it('attaches a failure class when cross-language could not be promoted', () => {
    const classes = provenRouteHandlerAnswer.failures.map((failure) => failure.failureClass);
    expect(classes).toContain('cross-language-below-promotion-threshold');
  });

  it('bounds downstream flow to a single hop', () => {
    expect(provenRouteHandlerAnswer.downstreamStep).not.toBeNull();
    expect(provenRouteHandlerAnswer.downstreamStep?.rationale).toBeTruthy();
  });

  it('exposes ownership as a first-class section, not adjacency', () => {
    expect(provenRouteHandlerAnswer.ownership).not.toBeNull();
    expect(provenRouteHandlerAnswer.ownership?.basis).not.toBe('unresolved');
  });
});
