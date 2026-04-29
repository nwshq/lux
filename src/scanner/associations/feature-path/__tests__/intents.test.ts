// Tests for the tranche-one feature-path question router.
//
// These tests pin the locked first supported question set: each intent has at
// least one canonical example, the router refuses to guess outside the locked
// set, and pattern ordering keeps contract questions from collapsing into
// route-handler.

import { describe, it, expect } from 'vitest';
import { FEATURE_PATH_QUESTION_PATTERNS, inferFeaturePathIntent } from '../intents.js';
import { FEATURE_PATH_INTENTS } from '../contract.js';

describe('inferFeaturePathIntent', () => {
  it.each([
    ['what handles POST /offers?', 'route-handler'],
    ['what handler is mapped to GET /users?', 'route-handler'],
    ['what part of the system owns POST /offers?', 'route-ownership'],
    ['who owns admin.reports.sync?', 'route-ownership'],
    ['where is POST /offers called from?', 'route-callers'],
    ['who calls /users/me', 'route-callers'],
    ['what request and response shape does POST /offers imply?', 'route-contract'],
    ['what shape does POST /offers expect?', 'route-contract'],
    ['what downstream work does POST /offers trigger?', 'route-downstream'],
    ['what does POST /offers dispatch?', 'route-downstream'],
  ])('routes %j to %s', (question, intent) => {
    const result = inferFeaturePathIntent(question);
    expect(result.intent).toBe(intent);
  });

  it('refuses to guess for an empty question', () => {
    const result = inferFeaturePathIntent('   ');
    expect(result.intent).toBeNull();
    expect(result.reason).toBe('no-question-text');
  });

  it('refuses to guess when no locked pattern matches', () => {
    const result = inferFeaturePathIntent('please explain this whole repository');
    expect(result.intent).toBeNull();
    expect(result.reason).toBe('no-pattern-match');
  });

  it('does not collapse contract questions into route-handler', () => {
    // The phrase "handler" must not win when the question is clearly about request shape.
    const result = inferFeaturePathIntent('what request shape does the offers handler accept?');
    expect(result.intent).toBe('route-contract');
  });
});

describe('FEATURE_PATH_QUESTION_PATTERNS', () => {
  it('only emits intents from the locked tranche-one set', () => {
    const allowed = new Set<string>(FEATURE_PATH_INTENTS);
    for (const pattern of FEATURE_PATH_QUESTION_PATTERNS) {
      expect(allowed.has(pattern.intent)).toBe(true);
    }
  });

  it('covers every locked intent with at least one example', () => {
    const covered = new Set(FEATURE_PATH_QUESTION_PATTERNS.map((pattern) => pattern.intent));
    for (const intent of FEATURE_PATH_INTENTS) {
      expect(covered.has(intent)).toBe(true);
    }
  });
});
