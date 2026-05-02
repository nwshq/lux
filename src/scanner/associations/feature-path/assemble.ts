// Tranche-one feature-path retrieval assembler.
//
// Phase 2 entry point: takes a resolved feature-path target and assembles a
// FeaturePathAnswer retrieval view from the existing structural overlay. This module is
// deliberately narrow:
//
//   - it ONLY assembles entry-surface and handler evidence here (T4)
//   - ownership, contracts, downstream, and cross-language sections are
//     assembled by their own tranche-two phases and merged in via the
//     `extensions` parameter
//   - it does not introduce new persistence; it reads through getSurfaceFeaturePath
//
// The assembler always runs the locked failure classifier at the end so
// partial answers carry their honesty statements (R5, R6, R15).

import type { LuxDatabase } from '../../../db/index.js';
import type { ConfidenceClass, StructuralNode } from '../../../db/types.js';
import {
  deriveOverlayTrustLevelFromState,
  inspectOverlayTrustState,
} from '../../overlay-trust-state.js';
import type { ModuleBoundaryConfig } from '../../imports/types.js';
import {
  CLOSURE_HANDLER_TOKEN,
  getSurfaceFeaturePath,
  type FeaturePath,
} from '../surface-retrieval.js';
import {
  FEATURE_PATH_ANSWER_SCHEMA_VERSION,
  type FeaturePathAnswer,
  type FeaturePathContextItem,
  type FeaturePathContracts,
  type FeaturePathCrossLanguage,
  type FeaturePathDirectEvidenceItem,
  type FeaturePathDownstreamStep,
  type FeaturePathIntent,
  type FeaturePathOwnership,
  type FeaturePathPrimaryAnswer,
  type FeaturePathResolution,
  type FeaturePathTarget,
} from './contract.js';
import { withClassifiedFailures } from './failures.js';
import { attributeFeaturePathOwnership } from './ownership.js';
import { buildContractDirectEvidence, summarizeFeaturePathContracts } from './contracts.js';
import { findBoundedDownstreamStep } from './downstream.js';
import {
  buildCrossLanguageDirectEvidence,
  evaluateCrossLanguagePromotion,
  promotedFrontendNodeIds,
} from './cross-language.js';

/**
 * Optional extensions appended by later phases (ownership in T5, contracts in
 * T6, downstream in T8, cross-language in T9). Keeping these in a separate
 * argument lets T4 stay focused on entry-surface and handler evidence without
 * creating tight coupling between phases.
 */
export interface FeaturePathAssemblyExtensions {
  ownership?: FeaturePathOwnership | null;
  contracts?: FeaturePathContracts | null;
  downstreamStep?: FeaturePathDownstreamStep | null;
  crossLanguage?: FeaturePathCrossLanguage | null;
  /** Additional direct-evidence items contributed by later phases. */
  additionalDirectEvidence?: FeaturePathDirectEvidenceItem[];
  /** Additional context items contributed by later phases. */
  additionalContext?: FeaturePathContextItem[];
}

export interface AssembleFeaturePathAnswerInput {
  question: string;
  intent: FeaturePathIntent;
  resolution: FeaturePathResolution;
  extensions?: FeaturePathAssemblyExtensions;
  /**
   * Repository root used to attribute ownership automatically when
   * `extensions.ownership` is not provided. Omit to skip auto-attribution
   * (callers passing ownership explicitly do not need this).
   */
  repoRoot?: string;
  /** Optional module-boundary config; falls back to known-pattern detection. */
  moduleBoundaryConfig?: ModuleBoundaryConfig;
}

/**
 * Trust tier assigned to structural overlay evidence in tranche one. The
 * structural overlay does not yet expose per-edge trust tiers in the same
 * 1..5 vocabulary as operational boundaries; we map confidence_class through
 * confidenceClassToTrustTier so the answer carries a comparable tier.
 */
function confidenceClassToTrustTier(
  confidenceClass: ConfidenceClass
): NonNullable<FeaturePathDirectEvidenceItem['trustTier']> {
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

function targetFromResolution(resolution: FeaturePathResolution): FeaturePathTarget | null {
  if (resolution.status === 'resolved' && resolution.candidates[0]) {
    return resolution.candidates[0];
  }
  return null;
}

function shortLabel(node: StructuralNode): string {
  if (node.symbol_name) return node.symbol_name;
  const lastColon = node.id.lastIndexOf(':');
  return lastColon >= 0 ? node.id.slice(lastColon + 1) : node.id;
}

function buildRouteDeclarationEvidence(
  target: FeaturePathTarget,
  declaringFile: StructuralNode | null
): FeaturePathDirectEvidenceItem {
  const filePath = declaringFile?.file_path ?? target.filePath ?? undefined;
  const trustTier = target.trustTier ?? 5;

  return {
    kind: 'route-declaration',
    description: filePath
      ? `${target.label ?? target.id} declared in ${filePath}`
      : `${target.label ?? target.id} declared as a capability surface`,
    nodeId: target.id,
    ...(filePath ? { filePath } : {}),
    trustTier,
    confidenceClass: 'proven',
  };
}

function buildHandlerEvidence(
  target: FeaturePathTarget,
  featurePath: FeaturePath
): FeaturePathDirectEvidenceItem | null {
  const provider = featurePath.providers[0];
  if (provider) {
    return {
      kind: 'handler-recovery',
      description: `${shortLabel(provider)} recovered via handled_by from ${target.label ?? target.id}`,
      nodeId: provider.id,
      ...(provider.file_path ? { filePath: provider.file_path } : {}),
      trustTier: confidenceClassToTrustTier('framework-inferred'),
      confidenceClass: 'framework-inferred',
    };
  }

  if (featurePath.isClosureBacked) {
    return {
      kind: 'handler-recovery',
      description: `${target.label ?? target.id} is handled by an inline closure (${CLOSURE_HANDLER_TOKEN})`,
      trustTier: confidenceClassToTrustTier('framework-inferred'),
      confidenceClass: 'framework-inferred',
    };
  }

  return null;
}

function buildConsumerContext(featurePath: FeaturePath): FeaturePathContextItem[] {
  const consumers =
    featurePath.provenConsumers.length > 0 ? featurePath.provenConsumers : featurePath.consumers;
  return consumers.slice(0, 5).map((consumer) => ({
    kind: 'nearby-consumer',
    description: `${shortLabel(consumer)} calls the surface`,
    nodeId: consumer.id,
    ...(consumer.file_path ? { filePath: consumer.file_path } : {}),
  }));
}

function ownershipSummaryClause(ownership: FeaturePathOwnership | null): string {
  if (!ownership || ownership.basis === 'unresolved') return '';
  return ` and belongs to ${ownership.regionName}`;
}

function summarizePrimaryAnswer(
  intent: FeaturePathIntent,
  target: FeaturePathTarget | null,
  handlerEvidence: FeaturePathDirectEvidenceItem | null,
  ownership: FeaturePathOwnership | null
): FeaturePathPrimaryAnswer {
  if (!target) {
    return {
      summary: 'Lux could not resolve the question to a feature-path target.',
      confidence: 'none',
    };
  }

  if (!handlerEvidence) {
    return {
      summary: `Lux resolved ${target.label ?? target.id} but did not recover a handler.`,
      confidence: 'none',
    };
  }

  const handlerLabel = handlerEvidence.nodeId
    ? handlerEvidence.description.split(' recovered ')[0]
    : 'an inline closure';

  const ownershipClause = ownershipSummaryClause(ownership);

  if (intent === 'route-handler' || intent === 'route-callers') {
    const targetLabel = target.label ?? target.id;
    if (intent === 'route-callers') {
      return {
        summary: `Persisted consumers for ${targetLabel} are listed under Context; handler evidence points to ${handlerLabel}${ownershipClause}.`,
        confidence: 'medium',
      };
    }
    return {
      summary: `${targetLabel} is handled by ${handlerLabel}${ownershipClause}.`,
      confidence: 'high',
    };
  }

  return {
    summary: `${target.label ?? target.id} is handled by ${handlerLabel}${ownershipClause}.`,
    confidence: 'medium',
  };
}

function collectEvidenceTrustTiers(
  evidence: FeaturePathDirectEvidenceItem[]
): NonNullable<FeaturePathDirectEvidenceItem['trustTier']>[] {
  const tiers: NonNullable<FeaturePathDirectEvidenceItem['trustTier']>[] = [];
  for (const item of evidence) {
    if (item.trustTier !== undefined) tiers.push(item.trustTier);
  }
  return tiers;
}

function isMixedTrust(
  target: FeaturePathTarget | null,
  evidenceTiers: number[],
  ownership: FeaturePathOwnership | null
): boolean {
  const tiers = new Set<number>();
  if (target?.trustTier !== undefined) tiers.add(target.trustTier);
  for (const tier of evidenceTiers) tiers.add(tier);
  if (ownership) tiers.add(ownership.trustTier);
  return tiers.size > 1;
}

/**
 * Assemble a FeaturePathAnswer from the structural overlay around a resolved
 * feature-path target. Ownership/contracts/downstream/cross-language are
 * passed in via `extensions` once their owning phases produce them.
 */
export function assembleFeaturePathAnswer(
  db: LuxDatabase,
  input: AssembleFeaturePathAnswerInput
): FeaturePathAnswer {
  const { question, intent, resolution } = input;
  const extensions = input.extensions ?? {};

  const overlayTrustLevel = deriveOverlayTrustLevelFromState(inspectOverlayTrustState(db).state);

  const target = targetFromResolution(resolution);

  const directEvidence: FeaturePathDirectEvidenceItem[] = [];
  const context: FeaturePathContextItem[] = [];

  let handlerEvidence: FeaturePathDirectEvidenceItem | null = null;
  let featurePath: FeaturePath | null = null;

  if (target?.kind === 'route-surface') {
    featurePath = getSurfaceFeaturePath(db, target.id);
    if (featurePath) {
      directEvidence.push(buildRouteDeclarationEvidence(target, featurePath.declaringFile));
      handlerEvidence = buildHandlerEvidence(target, featurePath);
      if (handlerEvidence) directEvidence.push(handlerEvidence);
      directEvidence.push(...buildContractDirectEvidence(featurePath));
      context.push(...buildConsumerContext(featurePath));
    } else {
      directEvidence.push(buildRouteDeclarationEvidence(target, null));
    }
  }

  if (extensions.additionalDirectEvidence?.length) {
    directEvidence.push(...extensions.additionalDirectEvidence);
  }
  if (extensions.additionalContext?.length) {
    context.push(...extensions.additionalContext);
  }

  let ownership: FeaturePathOwnership | null = extensions.ownership ?? null;
  if (ownership === null && input.repoRoot && target) {
    ownership = attributeFeaturePathOwnership({
      target,
      directEvidence,
      repoRoot: input.repoRoot,
      ...(input.moduleBoundaryConfig ? { moduleBoundaryConfig: input.moduleBoundaryConfig } : {}),
    });
  }
  const contracts =
    extensions.contracts !== undefined
      ? extensions.contracts
      : summarizeFeaturePathContracts(featurePath);
  const downstreamStep =
    extensions.downstreamStep !== undefined
      ? extensions.downstreamStep
      : findBoundedDownstreamStep(db, {
          handler: featurePath?.providers[0] ?? null,
        });
  const crossLanguage =
    extensions.crossLanguage !== undefined
      ? extensions.crossLanguage
      : evaluateCrossLanguagePromotion(db, {
          target,
          handlerLanguageId: featurePath?.providers[0]?.language_id ?? null,
        });

  // Promoted cross-language hops surface as direct evidence; refused hops
  // never do (T10, R6, R10) — they live in crossLanguage.associations only.
  directEvidence.push(...buildCrossLanguageDirectEvidence(crossLanguage));

  // Promoted consumers are PROOF, not adjacency: drop them from the
  // nearby-consumer context so the same node isn't presented twice.
  const promotedIds = promotedFrontendNodeIds(crossLanguage);
  const dedupedContext = promotedIds.size
    ? context.filter((item) => !item.nodeId || !promotedIds.has(item.nodeId))
    : context;

  const primaryAnswer = summarizePrimaryAnswer(intent, target, handlerEvidence, ownership);

  const evidenceTiers = collectEvidenceTrustTiers(directEvidence);

  const draft: FeaturePathAnswer = {
    schemaVersion: FEATURE_PATH_ANSWER_SCHEMA_VERSION,
    question,
    intent,
    overlayTrustLevel,
    resolution,
    target,
    primaryAnswer,
    ownership,
    contracts,
    directEvidence,
    context: dedupedContext,
    downstreamStep,
    crossLanguage,
    trust: {
      targetTrustTier: target?.trustTier ?? null,
      evidenceTrustTiers: evidenceTiers,
      ownershipTrustTier: ownership?.trustTier ?? null,
      mixedTrust: isMixedTrust(target, evidenceTiers, ownership),
    },
    failures: [],
  };

  return withClassifiedFailures(draft);
}
