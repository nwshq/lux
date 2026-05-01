// Failure classification and rendering rules for tranche-one feature-path
// retrieval.
//
// Honest refusal is a tranche-one product feature, not an error path. These
// rules ensure unresolved, ambiguous, weak-evidence, weak-ownership, and
// below-promotion cases remain explicit in both text and JSON output (R4,
// R5, R6, R15) instead of degrading into silent partial answers or fabricated
// proof.

import type { TrustTier } from '../../../db/types.js';
import type {
  FeaturePathAnswer,
  FeaturePathContracts,
  FeaturePathCrossLanguage,
  FeaturePathDirectEvidenceItem,
  FeaturePathFailure,
  FeaturePathFailureClass,
  FeaturePathIntent,
  FeaturePathOwnership,
  FeaturePathResolution,
  FeaturePathTarget,
} from './contract.js';

/**
 * Trust tier at or below which evidence is considered too weak to support a
 * compact retrieval summary. Mirrors the boundary used by overlay operational ask
 * (`tier < 4` → medium confidence) so the two surfaces grade evidence the
 * same way.
 */
export const WEAK_EVIDENCE_TRUST_TIER: TrustTier = 2;

/** Trust tier at or below which an ownership attribution is considered weak. */
export const WEAK_OWNERSHIP_TRUST_TIER: TrustTier = 2;

/**
 * Direct evidence kinds that count as a recovered handler for the purposes of
 * the `missing-handler-recovery` failure rule.
 */
const HANDLER_EVIDENCE_KINDS = new Set<FeaturePathDirectEvidenceItem['kind']>([
  'handler-recovery',
  'event-listener-registration',
]);

/**
 * Inputs to the failure classifier. The classifier never mutates the answer;
 * it only reads what was assembled and reports which failures apply.
 */
export interface FeaturePathFailureContext {
  intent: FeaturePathIntent;
  resolution: FeaturePathResolution;
  target: FeaturePathTarget | null;
  ownership: FeaturePathOwnership | null;
  contracts: FeaturePathContracts | null;
  directEvidence: FeaturePathDirectEvidenceItem[];
  crossLanguage: FeaturePathCrossLanguage | null;
}

/**
 * Apply the locked failure rules to an assembled answer state. Returns the
 * complete list of failures that apply, in declaration order.
 *
 * Rules:
 *   - `unresolved-target`           — resolution.status === 'unresolved'
 *   - `ambiguous-target`            — resolution.status === 'ambiguous'
 *   - `missing-handler-recovery`    — resolved route-surface target has no handler-recovery
 *                                     or event-listener-registration in direct evidence
 *   - `weak-ownership`              — ownership is null, basis is 'unresolved',
 *                                     or trustTier <= WEAK_OWNERSHIP_TRUST_TIER
 *   - `insufficient-contract-recovery`
 *                                   — intent is 'route-contract' but no request and
 *                                     no response contract was recovered
 *   - `insufficient-direct-evidence`
 *                                   — directEvidence is empty, or every item is at or
 *                                     below WEAK_EVIDENCE_TRUST_TIER, or every item is
 *                                     a route-declaration (declaration alone does not
 *                                     prove a handler)
 *   - `cross-language-below-promotion-threshold`
 *                                   — crossLanguage.status starts with 'refused-'
 */
export function classifyFeaturePathFailures(
  context: FeaturePathFailureContext
): FeaturePathFailure[] {
  const failures: FeaturePathFailure[] = [];

  if (context.resolution.status === 'unresolved') {
    failures.push({
      failureClass: 'unresolved-target',
      detail: `Lux could not resolve "${context.resolution.query}" to a persisted feature-path target.`,
    });
  } else if (context.resolution.status === 'ambiguous') {
    failures.push({
      failureClass: 'ambiguous-target',
      detail: `Multiple persisted feature-path targets matched "${context.resolution.query}". Refusing to pick one without operator disambiguation.`,
    });
  }

  if (
    context.resolution.status === 'resolved' &&
    context.target?.kind === 'route-surface' &&
    !context.directEvidence.some((item) => HANDLER_EVIDENCE_KINDS.has(item.kind))
  ) {
    failures.push({
      failureClass: 'missing-handler-recovery',
      detail:
        'Route surface resolved, but no persisted handler recovery (handled_by / event listener) was found.',
    });
  }

  if (isOwnershipWeak(context.ownership)) {
    failures.push({
      failureClass: 'weak-ownership',
      detail: ownershipFailureDetail(context.ownership),
    });
  }

  if (context.intent === 'route-contract' && !hasRecoveredContract(context.contracts)) {
    failures.push({
      failureClass: 'insufficient-contract-recovery',
      detail:
        'Question asked for request/response shape, but no structurally recoverable contract was found.',
    });
  }

  if (isDirectEvidenceInsufficient(context.directEvidence)) {
    failures.push({
      failureClass: 'insufficient-direct-evidence',
      detail: directEvidenceFailureDetail(context.directEvidence),
    });
  }

  if (context.crossLanguage && context.crossLanguage.status.startsWith('refused-')) {
    failures.push({
      failureClass: 'cross-language-below-promotion-threshold',
      detail:
        context.crossLanguage.rationale ??
        'Cross-language association did not meet the promotion threshold.',
    });
  }

  return failures;
}

function isOwnershipWeak(ownership: FeaturePathOwnership | null): boolean {
  if (!ownership) return true;
  if (ownership.basis === 'unresolved') return true;
  return ownership.trustTier <= WEAK_OWNERSHIP_TRUST_TIER;
}

function ownershipFailureDetail(ownership: FeaturePathOwnership | null): string {
  if (!ownership) return 'No ownership region could be attributed to this target.';
  if (ownership.basis === 'unresolved') {
    return 'Ownership region was attributed but the basis is unresolved.';
  }
  return `Ownership trust tier ${ownership.trustTier} is at or below the weak-ownership threshold (${WEAK_OWNERSHIP_TRUST_TIER}).`;
}

function hasRecoveredContract(contracts: FeaturePathContracts | null): boolean {
  if (!contracts) return false;
  return Boolean(contracts.request ?? contracts.response);
}

function isDirectEvidenceInsufficient(items: FeaturePathDirectEvidenceItem[]): boolean {
  if (items.length === 0) return true;

  const everyItemBelowFloor = items.every(
    (item) => (item.trustTier ?? 1) <= WEAK_EVIDENCE_TRUST_TIER
  );
  if (everyItemBelowFloor) return true;

  const everyItemDeclarationOnly = items.every((item) => item.kind === 'route-declaration');
  return everyItemDeclarationOnly;
}

function directEvidenceFailureDetail(items: FeaturePathDirectEvidenceItem[]): string {
  if (items.length === 0) {
    return 'No direct evidence was recovered for the compact retrieval summary.';
  }
  if (items.every((item) => item.kind === 'route-declaration')) {
    return 'Direct evidence is limited to a route declaration; no handler, contract, or dispatch evidence was recovered.';
  }
  return `All direct evidence is at or below trust tier ${WEAK_EVIDENCE_TRUST_TIER}.`;
}

// ---------------------------------------------------------------------------
// Rendering rules
// ---------------------------------------------------------------------------

const FAILURE_HEADERS: Record<FeaturePathFailureClass, string> = {
  'unresolved-target': 'Unresolved target',
  'ambiguous-target': 'Ambiguous target',
  'missing-handler-recovery': 'Missing handler recovery',
  'weak-ownership': 'Weak ownership',
  'insufficient-contract-recovery': 'Insufficient contract recovery',
  'insufficient-direct-evidence': 'Insufficient direct evidence',
  'cross-language-below-promotion-threshold': 'Cross-language below promotion threshold',
};

/**
 * Render the `failures` section of a feature-path answer for text output.
 *
 * Rules:
 *   - Empty failures render nothing (no "no failures" line).
 *   - Each failure renders header + detail on its own pair of lines.
 *   - Failures appear AFTER direct evidence and context so the reader sees
 *     the answer first, then the explicit honesty statement.
 *   - Failure text never overrides the compact summary: a partial evidence
 *     packet with attached failures is preferred over silent omission.
 */
export function renderFeaturePathFailures(failures: FeaturePathFailure[]): string[] {
  if (failures.length === 0) return [];

  const lines: string[] = ['', 'Failures'];
  for (const failure of failures) {
    lines.push(`- ${FAILURE_HEADERS[failure.failureClass]}: ${failure.detail}`);
  }
  return lines;
}

/**
 * Recompute and attach failures to an assembled answer. Pure: returns a new
 * answer object rather than mutating in place. Useful for assembly code that
 * builds the answer in stages and needs to apply the locked rules at the end.
 */
export function withClassifiedFailures(answer: FeaturePathAnswer): FeaturePathAnswer {
  const failures = classifyFeaturePathFailures({
    intent: answer.intent,
    resolution: answer.resolution,
    target: answer.target,
    ownership: answer.ownership,
    contracts: answer.contracts,
    directEvidence: answer.directEvidence,
    crossLanguage: answer.crossLanguage,
  });

  return { ...answer, failures };
}
