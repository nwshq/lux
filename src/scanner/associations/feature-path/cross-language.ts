// Tranche-one cross-language promotion for feature-path answers.
//
// Backends and frontends are routinely connected by `calls_surface` edges
// produced by frontend resolvers, but those edges range from
// artifact-backed (e.g. generated-types) all the way down to naming-only
// heuristics. The feature-path answer surface must NOT present a weak
// association as a real cross-language feature path (R6, R10).
//
// This module:
//   - walks `calls_surface` edges where the route surface is the target,
//   - classifies each cross-language consumer as a basis (`generated-types`
//     when artifact-backed/proven; `naming-only` otherwise),
//   - applies the promotion threshold, and
//   - returns one of `promoted` | `refused-low-trust` | `refused-naming-only`
//     | `not-applicable`. Returns `null` when there are no cross-language
//     consumers at all (the section is omitted entirely in that case so
//     adjacency never reads as proof).
//
// Conservative on purpose: in tranche one we recognize only `generated-types`
// as a real basis. `shared-config` and `shared-event` exist in the contract
// vocabulary for future detectors but are NOT inferred here, because doing so
// would over-claim. New bases require their own detectors before promotion.

import { LuxDatabase } from '../../../db/index.js';
import type {
  ConfidenceClass,
  EdgeEvidence,
  StructuralEdge,
  TrustTier,
} from '../../../db/types.js';
import type {
  CrossLanguageBasis,
  CrossLanguageStatus,
  FeaturePathCrossLanguage,
  FeaturePathCrossLanguageAssociation,
  FeaturePathDirectEvidenceItem,
  FeaturePathTarget,
} from './contract.js';

/**
 * Minimum trust tier required for promotion. Mirrors the artifact-backed
 * floor used elsewhere in the answer surface (contracts: tier 4 = exact;
 * ownership: tier 4 = module-boundary). Below this we refuse.
 */
export const CROSS_LANGUAGE_PROMOTION_TRUST_TIER: TrustTier = 4;

export interface EvaluateCrossLanguagePromotionInput {
  /** The resolved feature-path target. Only `route-surface` targets are evaluated. */
  target: FeaturePathTarget | null;
  /**
   * Language id of the recovered handler/provider, e.g. `'php'`. Used to
   * classify which consumers are truly cross-language. When null, evaluation
   * is skipped (we cannot honestly compare languages without knowing the
   * handler side).
   */
  handlerLanguageId: string | null;
}

/**
 * Evaluate cross-language consumers of a route surface and apply the locked
 * promotion threshold. Returns:
 *   - `null` when no cross-language consumers exist at all.
 *   - a `FeaturePathCrossLanguage` block with the appropriate status otherwise.
 */
export function evaluateCrossLanguagePromotion(
  db: LuxDatabase,
  input: EvaluateCrossLanguagePromotionInput
): FeaturePathCrossLanguage | null {
  const { target, handlerLanguageId } = input;
  if (!target || target.kind !== 'route-surface' || !handlerLanguageId) {
    return null;
  }

  const associations = collectCrossLanguageAssociations(db, target.id, handlerLanguageId);
  if (associations.length === 0) return null;

  const status = pickStatus(associations);
  const trustTier = pickAggregateTrustTier(associations, status);
  const rationale = buildRationale(status, associations);

  const block: FeaturePathCrossLanguage = {
    status,
    associations,
  };
  if (trustTier !== undefined) block.trustTier = trustTier;
  if (rationale) block.rationale = rationale;
  return block;
}

/**
 * Walk `calls_surface` edges into the surface and return one association per
 * cross-language consumer.
 */
function collectCrossLanguageAssociations(
  db: LuxDatabase,
  surfaceId: string,
  handlerLanguageId: string
): FeaturePathCrossLanguageAssociation[] {
  const edges = db.getRelatedEdgesWithEvidence(surfaceId);
  const associations: FeaturePathCrossLanguageAssociation[] = [];

  for (const { edge, evidence } of edges) {
    if (edge.edge_type !== 'calls_surface') continue;
    if (edge.target_node_id !== surfaceId) continue;

    const consumer = db.getStructuralNode(edge.source_node_id);
    if (!consumer) continue;
    // Defence in depth (ADR-3 / REQ-7): boundary edges are `calls`, not
    // `calls_surface`, so a vendor node cannot reach here today — but never
    // surface a merged external node as a cross-language consumer regardless.
    if (LuxDatabase.isExternalNode(consumer)) continue;
    if (!consumer.language_id || consumer.language_id === handlerLanguageId) continue;

    const basis = inferBasis(edge, evidence);
    const trustTier = confidenceClassToTrustTier(edge.confidence_class);

    associations.push({
      backendNodeId: surfaceId,
      frontendNodeId: consumer.id,
      basis,
      trustTier,
      ...(consumer.file_path ? { filePath: consumer.file_path } : {}),
    });
  }

  associations.sort(
    (left, right) =>
      right.trustTier - left.trustTier || left.frontendNodeId.localeCompare(right.frontendNodeId)
  );

  return associations;
}

/**
 * Map an edge's confidence class and resolver provenance to a basis.
 * Tranche one only recognizes `generated-types` as a real basis; everything
 * else is `naming-only` so we do not over-claim.
 */
function inferBasis(edge: StructuralEdge, evidence: EdgeEvidence[]): CrossLanguageBasis {
  if (evidence.some((item) => item.resolver === 'generated-types')) {
    return 'generated-types';
  }
  if (edge.confidence_class === 'proven' || edge.confidence_class === 'artifact-backed') {
    return 'generated-types';
  }
  return 'naming-only';
}

function confidenceClassToTrustTier(confidenceClass: ConfidenceClass): TrustTier {
  switch (confidenceClass) {
    case 'proven':
      return 5;
    case 'artifact-backed':
      return 4;
    case 'framework-inferred':
      return 3;
    case 'heuristic':
      return 2;
    default:
      return 2;
  }
}

function pickStatus(associations: FeaturePathCrossLanguageAssociation[]): CrossLanguageStatus {
  const hasPromotable = associations.some(
    (assoc) =>
      assoc.basis !== 'naming-only' && assoc.trustTier >= CROSS_LANGUAGE_PROMOTION_TRUST_TIER
  );
  if (hasPromotable) return 'promoted';

  const allNamingOnly = associations.every((assoc) => assoc.basis === 'naming-only');
  if (allNamingOnly) return 'refused-naming-only';

  return 'refused-low-trust';
}

function pickAggregateTrustTier(
  associations: FeaturePathCrossLanguageAssociation[],
  status: CrossLanguageStatus
): TrustTier | undefined {
  if (status !== 'promoted') return undefined;
  let best: TrustTier = associations[0].trustTier;
  for (const assoc of associations) {
    if (assoc.basis === 'naming-only') continue;
    if (assoc.trustTier > best) best = assoc.trustTier;
  }
  return best;
}

function buildRationale(
  status: CrossLanguageStatus,
  associations: FeaturePathCrossLanguageAssociation[]
): string | undefined {
  switch (status) {
    case 'promoted':
      return `Promoted ${countByBasis(associations)} based on artifact-backed cross-language association at trust tier ${CROSS_LANGUAGE_PROMOTION_TRUST_TIER} or higher.`;
    case 'refused-naming-only':
      return 'All cross-language associations are naming-only; no artifact-backed or schema-backed bridge exists. Refusing to present this as a real feature path.';
    case 'refused-low-trust':
      return `Cross-language associations exist but all are below the promotion trust tier (${CROSS_LANGUAGE_PROMOTION_TRUST_TIER}). Refusing to promote.`;
    case 'not-applicable':
      return undefined;
    default:
      return undefined;
  }
}

function countByBasis(associations: FeaturePathCrossLanguageAssociation[]): string {
  const total = associations.length;
  const promotable = associations.filter(
    (assoc) =>
      assoc.basis !== 'naming-only' && assoc.trustTier >= CROSS_LANGUAGE_PROMOTION_TRUST_TIER
  ).length;
  return `${promotable} of ${total} cross-language association${total === 1 ? '' : 's'}`;
}

/**
 * Build direct-evidence items from a cross-language evaluation result.
 *
 * Tranche-one rule (T10, R6, R10):
 *   - PROMOTED associations may surface as direct evidence under the
 *     `high-trust-cross-language-association` kind.
 *   - REFUSED associations MUST NOT be lifted to direct evidence under any
 *     kind; their place is `crossLanguage.associations[]` only, where
 *     consumers can audit the refusal.
 *
 * Returns an empty array for refused / not-applicable / null inputs.
 */
export function buildCrossLanguageDirectEvidence(
  crossLanguage: FeaturePathCrossLanguage | null
): FeaturePathDirectEvidenceItem[] {
  if (!crossLanguage) return [];
  if (crossLanguage.status !== 'promoted') return [];

  const promotable = crossLanguage.associations.filter(
    (assoc) =>
      assoc.basis !== 'naming-only' && assoc.trustTier >= CROSS_LANGUAGE_PROMOTION_TRUST_TIER
  );
  if (promotable.length === 0) return [];

  const best = promotable[0];
  const item: FeaturePathDirectEvidenceItem = {
    kind: 'high-trust-cross-language-association',
    description: `Backend surface bridged to ${best.frontendNodeId} via ${best.basis} (tier ${best.trustTier}).`,
    nodeId: best.frontendNodeId,
    trustTier: best.trustTier,
    confidenceClass: best.trustTier >= 5 ? 'proven' : 'artifact-backed',
  };
  if (best.filePath) item.filePath = best.filePath;
  return [item];
}

/**
 * Return the set of frontend node ids that have been promoted to direct
 * evidence, so callers can dedupe them out of contextual `nearby-consumer`
 * items. Promoted associations are PROOF, not adjacency, and must not appear
 * in both sections (R5, R6).
 */
export function promotedFrontendNodeIds(
  crossLanguage: FeaturePathCrossLanguage | null
): Set<string> {
  if (!crossLanguage || crossLanguage.status !== 'promoted') return new Set();
  return new Set(
    crossLanguage.associations
      .filter(
        (assoc) =>
          assoc.basis !== 'naming-only' && assoc.trustTier >= CROSS_LANGUAGE_PROMOTION_TRUST_TIER
      )
      .map((assoc) => assoc.frontendNodeId)
  );
}
