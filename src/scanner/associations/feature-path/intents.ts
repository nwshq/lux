// Tranche-one feature-path question router.
//
// Locks the first supported set of natural-language question patterns to the
// FeaturePathIntent enum from contract.ts. Tranche one stays narrow on
// route- and handler-centered questions. New intents are deliberately rejected
// here so detector breadth does not creep into a retrieval tranche (R11).
//
// Mirrors the keyword-based router used by overlay operational ask
// (src/cli/operational.ts inferIntent) so operators reason in the same style
// across surfaces.

import type { FeaturePathIntent } from './contract.js';

/**
 * Outcome of attempting to route a question to a tranche-one intent.
 *
 *   - `intent` — best-effort intent assignment when the question matches a
 *                locked pattern.
 *   - `unsupported` — intent is `null` and a reason is given. Tranche one
 *                     refuses to guess outside the locked set rather than
 *                     drifting toward broad-surface answers.
 */
export interface FeaturePathIntentResolution {
  intent: FeaturePathIntent | null;
  reason?: 'no-pattern-match' | 'no-question-text';
}

/**
 * A single locked question pattern. `match` is checked against the
 * lower-cased, trimmed question. The first matching pattern wins, in the
 * order patterns are listed.
 */
export interface FeaturePathQuestionPattern {
  intent: FeaturePathIntent;
  /** Plain-language description of the example question class. */
  example: string;
  match: RegExp;
}

/**
 * The locked tranche-one question set.
 *
 * Order matters: more-specific patterns are listed before more-general ones
 * so that, for example, "what request shape" (route-contract) wins over
 * generic "what handles" (route-handler).
 *
 * Patterns are intentionally narrow. Tranche one explicitly does NOT support:
 *   - generic "what does this app do" questions
 *   - feature questions starting from a frontend symbol
 *   - questions about runtime errors, deploys, or jobs not reached from a route
 */
export const FEATURE_PATH_QUESTION_PATTERNS: readonly FeaturePathQuestionPattern[] = [
  // Contracts come first — "what request shape" must not collapse into route-handler.
  {
    intent: 'route-contract',
    example: 'what request and response shape does POST /offers imply?',
    match: /\b(request|response|payload)\b.*\b(shape|contract|body|schema)\b/i,
  },
  {
    intent: 'route-contract',
    example: 'what shape does POST /offers expect?',
    match: /\bwhat\b.*\bshape\b/i,
  },

  // Downstream — explicit "trigger" / "downstream" wording.
  {
    intent: 'route-downstream',
    example: 'what downstream work does POST /offers trigger?',
    match: /\b(downstream|trigger(s|ed)?|dispatch(es|ed)?|fan[-\s]?out)\b/i,
  },

  // Callers — "where is this called from".
  {
    intent: 'route-callers',
    example: 'where is POST /offers called from?',
    match: /\b(called|calls?)\b\s+from\b/i,
  },
  {
    intent: 'route-callers',
    example: 'who calls POST /offers?',
    match: /\bwho\s+calls?\b/i,
  },

  // Ownership — "owns", "responsible", "domain".
  {
    intent: 'route-ownership',
    example: 'what owns POST /offers?',
    match: /\b(owns|owner|responsible\s+for|which\s+domain|what\s+part\s+of\s+the\s+system)\b/i,
  },

  // Handler — default route-centered "what handles".
  {
    intent: 'route-handler',
    example: 'what handles POST /offers?',
    match: /\b(handles?|handler|routes?\s+to|maps?\s+to)\b/i,
  },
];

const QUESTION_NORMALIZE = /\s+/g;

function normalizeQuestion(question: string): string {
  return question.toLowerCase().replace(QUESTION_NORMALIZE, ' ').trim();
}

/**
 * Route a natural-language question to a tranche-one FeaturePathIntent.
 *
 * Returns a structured resolution rather than throwing or returning a
 * fallback intent: tranche one prefers explicit refusal ("no pattern matched")
 * over confidently mis-classifying a question into a locked intent.
 */
export function inferFeaturePathIntent(question: string): FeaturePathIntentResolution {
  const normalized = normalizeQuestion(question);
  if (!normalized) {
    return { intent: null, reason: 'no-question-text' };
  }

  for (const pattern of FEATURE_PATH_QUESTION_PATTERNS) {
    if (pattern.match.test(normalized)) {
      return { intent: pattern.intent };
    }
  }

  return { intent: null, reason: 'no-pattern-match' };
}
