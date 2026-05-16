import type {
  SpecDerivationClaimType,
  SpecDerivationEvidenceClaim,
  SpecDerivationMutationKind,
} from './contract.js';

const MUTATION_PATTERNS: Array<[RegExp, SpecDerivationMutationKind]> = [
  [/\b(create|insert|store|save|persist)\b/i, 'create'],
  [/\b(update|patch|sync)\b/i, 'update'],
  [/\b(delete|destroy|remove)\b/i, 'delete'],
  [/\b(transaction|commit|rollback)\b/i, 'transaction_boundary'],
  [/\b(dispatch|dispatches|dispatched|queue|job)\b/i, 'job_dispatch'],
  [/\b(event|emit|publish)\b/i, 'event_emit'],
  [/\b(upload|write|put object|storage)\b/i, 'file_or_object_write'],
  [/\b(http|api|provider|webhook|payment|notification)\b/i, 'external_mutation'],
];

const DECISION_PATTERNS: Array<[RegExp, SpecDerivationClaimType]> = [
  [/\b(validate|validation|request)\b/i, 'validation'],
  [/\b(authorize|policy|permission|auth)\b/i, 'authorization'],
  [/\b(status|state|guard)\b/i, 'state_guard'],
  [/\b(flag|config|setting)\b/i, 'configuration_dependency'],
  [/\b(retry|backoff)\b/i, 'retry_or_backoff'],
  [/\b(idempotent|duplicate|already)\b/i, 'idempotency_guard'],
];

export function classifyMutationKind(text: string): SpecDerivationMutationKind {
  for (const [pattern, kind] of MUTATION_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return 'unknown_side_effect';
}

export function classifyDecisionClaimType(text: string): SpecDerivationClaimType {
  for (const [pattern, kind] of DECISION_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return 'branch';
}

export function claimsIncludeDirectEvidence(claims: SpecDerivationEvidenceClaim[]): boolean {
  return claims.some(
    (claim) =>
      claim.support !== 'weak' &&
      claim.support !== 'insufficient' &&
      claim.support !== 'conflicting' &&
      claim.evidence.some((ref) => ref.evidenceStrength === 'direct')
  );
}
