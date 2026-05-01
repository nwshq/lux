// Tranche-one feature-path retrieval-view contract.
//
// This module is the single source of truth for the FeaturePathAnswer shape
// that Lux returns as a compact evidence packet for a route- or
// handler-centered feature-path question. It is the TypeScript mirror of
// schemas/feature-path-answer.schema.json — both files MUST move together.
//
// The contract intentionally:
//   - keeps a compact summary slot while preserving evidence-first semantics
//   - separates direct evidence from context (R5, R6)
//   - makes ownership a first-class part of the retrieval view (R7)
//   - bounds downstream operational explanation to one hop (R8)
//   - exposes cross-language refusal modes explicitly (R6, R10)
//   - reuses existing Lux trust grading rather than inventing a new one (R9)

import type { TrustTier, ConfidenceClass } from '../../../db/types.js';

/** Schema version. Bumped on any breaking change to the FeaturePathAnswer shape. */
export const FEATURE_PATH_ANSWER_SCHEMA_VERSION = 1 as const;
export type FeaturePathAnswerSchemaVersion = typeof FEATURE_PATH_ANSWER_SCHEMA_VERSION;

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

/**
 * First locked set of supported feature-path intents.
 *
 * Tranche one stays narrow on route- and handler-centered questions.
 * Detector expansion is explicitly NOT a tranche-one success criterion (R11).
 *
 *   - `route-handler`     — what handles this endpoint?
 *   - `route-ownership`   — what part of the system owns this route or workflow?
 *   - `route-callers`     — which persisted consumers/context reference this route?
 *   - `route-contract`    — what request/response shape does this imply?
 *   - `route-downstream`  — what downstream work does this feature trigger?
 */
export type FeaturePathIntent =
  | 'route-handler'
  | 'route-ownership'
  | 'route-callers'
  | 'route-contract'
  | 'route-downstream';

export const FEATURE_PATH_INTENTS: readonly FeaturePathIntent[] = [
  'route-handler',
  'route-ownership',
  'route-callers',
  'route-contract',
  'route-downstream',
] as const;

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type ResolutionStatus = 'resolved' | 'unresolved' | 'ambiguous';

/**
 * How the question target was matched to a persisted feature-path target.
 * `semantic-exact` means equality after normalization (case, framework prefixes,
 * route shape). It is treated as a tier above `prefix` and `contains`.
 */
export type ResolutionMatchType = 'exact' | 'semantic-exact' | 'prefix' | 'contains';

// `handler-symbol` is reserved in the schema vocabulary for future persisted
// target forms; tranche one resolves promoted asks from capability surfaces.
export type FeaturePathTargetKind = 'route-surface' | 'handler-symbol' | 'unresolved';

export interface FeaturePathTarget {
  kind: FeaturePathTargetKind;
  /** Persisted node ID. For route surfaces this is the capability-surface ID. */
  id: string;
  /** Display label suitable for the primary-answer summary line. */
  label?: string;
  filePath?: string | null;
  surfaceMethod?: string;
  surfacePath?: string;
  routeName?: string;
  trustTier?: TrustTier;
}

export interface FeaturePathResolution {
  query: string;
  status: ResolutionStatus;
  matchedBy?: ResolutionMatchType;
  /**
   * Up to a small number of plausible targets. Populated for both ambiguous
   * and unresolved statuses to make refusal honest and actionable.
   */
  candidates: FeaturePathTarget[];
}

// ---------------------------------------------------------------------------
// Primary answer
// ---------------------------------------------------------------------------

/**
 * Confidence band for the compact summary. Mirrors operational ask grading so
 * the two retrieval surfaces remain comparable.
 */
export type FeaturePathConfidence = 'high' | 'medium' | 'none';

export interface FeaturePathPrimaryAnswer {
  /**
   * Single-sentence plain-language statement of the strongest evidence-backed retrieval claim.
   * Example: `POST /offers is handled by OfferController@store and belongs to Listings.`
   */
  summary: string;
  confidence: FeaturePathConfidence;
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/**
 * How ownership was attributed. Mirrors the existing expert `boundary_basis`
 * vocabulary so feature-path retrieval and panel boundaries reason in the same terms.
 */
export type OwnershipBasis =
  | 'module-boundary'
  | 'directory-led'
  | 'overlay-led'
  | 'hybrid'
  | 'unresolved';

export interface FeaturePathOwnership {
  /** Stable identifier (e.g. `module:Listings` or `directory:app/Modules/Listings`). */
  regionId: string;
  regionName: string;
  basis: OwnershipBasis;
  trustTier: TrustTier;
  /** Required when `basis` is `overlay-led` or `hybrid` so the basis is not opaque. */
  rationale?: string;
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export type ContractShapeConfidence = 'exact' | 'coarse';

export interface FeaturePathContractFragment {
  /** Display label, e.g. `exact(StoreOfferRequest)` or `coarse(empty-ack)`. */
  label: string;
  contractKind?: string;
  shapeConfidence?: ContractShapeConfidence;
  nodeId?: string;
  filePath?: string;
}

export interface FeaturePathDownstreamPayloadFragment {
  label: string;
  boundaryId?: string;
  trustTier?: TrustTier;
}

export interface FeaturePathContracts {
  request?: FeaturePathContractFragment;
  response?: FeaturePathContractFragment;
  downstreamPayload?: FeaturePathDownstreamPayloadFragment;
  /** Dominant interactionKind extracted from contracts (e.g. `api`, `page-rendered`). */
  interactionKind?: string;
}

// ---------------------------------------------------------------------------
// Direct evidence vs context
// ---------------------------------------------------------------------------

/**
 * Kinds of evidence that may legitimately appear under `directEvidence`.
 * Adjacent or contextual signal must NOT use these kinds — it belongs in `context`.
 *
 * New kinds require a contract version bump.
 */
export type DirectEvidenceKind =
  | 'route-declaration'
  | 'handler-recovery'
  | 'validator-attachment'
  | 'response-contract'
  | 'dispatch-call'
  | 'event-listener-registration'
  | 'high-trust-cross-language-association';

/**
 * Kinds of contextual signal that may appear under `context`.
 * These must NEVER be rendered as proof of the compact summary.
 */
export type ContextKind =
  | 'nearby-consumer'
  | 'related-job'
  | 'neighboring-component'
  | 'region-adjacency'
  | 'co-located-symbol';

export interface FeaturePathDirectEvidenceItem {
  kind: DirectEvidenceKind;
  description: string;
  nodeId?: string;
  edgeId?: string;
  filePath?: string;
  trustTier?: TrustTier;
  confidenceClass?: ConfidenceClass;
}

export interface FeaturePathContextItem {
  kind: ContextKind;
  description: string;
  nodeId?: string;
  edgeId?: string;
  filePath?: string;
  trustTier?: TrustTier;
}

// ---------------------------------------------------------------------------
// Bounded downstream step
// ---------------------------------------------------------------------------

/**
 * Operational edge type for the bounded downstream hop. Constrained to the
 * persisted OperationalEdgeType vocabulary so the downstream slot never
 * fabricates an edge type the substrate cannot back.
 */
export type DownstreamEdgeType = 'DISPATCHES' | 'TRIGGERS' | 'HANDLED_BY' | 'CONSUMES' | 'PRODUCES';

export type DownstreamTransport = 'sync' | 'async' | 'queue' | 'event-bus';

export interface FeaturePathDownstreamEndpoint {
  id: string;
  label?: string;
  filePath?: string;
}

export interface FeaturePathDownstreamStep {
  description: string;
  edgeType: DownstreamEdgeType;
  transport?: DownstreamTransport;
  source: FeaturePathDownstreamEndpoint;
  target: FeaturePathDownstreamEndpoint;
  trustTier: TrustTier;
  /**
   * Why this single hop materially completes the answer. Required because the
   * downstream slot is bounded to ONE step.
   */
  rationale?: string;
}

// ---------------------------------------------------------------------------
// Cross-language promotion
// ---------------------------------------------------------------------------

/**
 * Outcome of the cross-language promotion decision.
 *
 * `refused-*` values are explicit honest refusals (R6, R10) and MUST NOT be
 * hidden when the question implied a frontend hop.
 */
export type CrossLanguageStatus =
  | 'promoted'
  | 'refused-low-trust'
  | 'refused-naming-only'
  | 'not-applicable';

// `shared-config` and `shared-event` are reserved vocabulary for future
// artifact-backed detectors. Tranche one only promotes `generated-types`;
// unsupported bases remain refused rather than inferred.
export type CrossLanguageBasis =
  | 'generated-types'
  | 'shared-config'
  | 'shared-event'
  | 'naming-only';

export interface FeaturePathCrossLanguageAssociation {
  backendNodeId: string;
  frontendNodeId: string;
  basis: CrossLanguageBasis;
  trustTier: TrustTier;
  filePath?: string;
}

export interface FeaturePathCrossLanguage {
  status: CrossLanguageStatus;
  /** Aggregate trust tier of the strongest promoted association. Absent for refused-* / not-applicable. */
  trustTier?: TrustTier;
  /**
   * Concrete associations considered. For refused-* statuses, this MAY be
   * populated to make refusal auditable; consumers MUST NOT render refused
   * associations as feature paths.
   */
  associations: FeaturePathCrossLanguageAssociation[];
  /** Required for refused-* so refusal is not silent. */
  rationale?: string;
}

// ---------------------------------------------------------------------------
// Trust and failures
// ---------------------------------------------------------------------------

export interface FeaturePathTrust {
  targetTrustTier: TrustTier | null;
  evidenceTrustTiers: TrustTier[];
  ownershipTrustTier: TrustTier | null;
  /** True iff target/evidence/ownership tiers contain more than one distinct value. */
  mixedTrust: boolean;
}

/**
 * Shared failure taxonomy. Validation reports and answer payloads use the same
 * vocabulary so misses can be classified without translation (R15).
 */
export type FeaturePathFailureClass =
  | 'unresolved-target'
  | 'ambiguous-target'
  | 'missing-handler-recovery'
  | 'weak-ownership'
  | 'insufficient-contract-recovery'
  | 'insufficient-direct-evidence'
  | 'cross-language-below-promotion-threshold';

export const FEATURE_PATH_FAILURE_CLASSES: readonly FeaturePathFailureClass[] = [
  'unresolved-target',
  'ambiguous-target',
  'missing-handler-recovery',
  'weak-ownership',
  'insufficient-contract-recovery',
  'insufficient-direct-evidence',
  'cross-language-below-promotion-threshold',
] as const;

export interface FeaturePathFailure {
  failureClass: FeaturePathFailureClass;
  detail: string;
}

// ---------------------------------------------------------------------------
// Top-level answer
// ---------------------------------------------------------------------------

/**
 * Tranche-one feature-path retrieval view. The single evidence-packet surface
 * returned to operators and tooling for the locked set of route- and
 * handler-centered feature questions. The `Answer` name is retained as the
 * stable public contract, but the semantics are retrieval-first: summary,
 * evidence, context, provenance, trust, and explicit refusal.
 *
 * Field order in this interface mirrors text-rendering order so readers can
 * scan the type and the rendered retrieval view in the same direction.
 */
export interface FeaturePathAnswer {
  schemaVersion: FeaturePathAnswerSchemaVersion;
  question: string;
  intent: FeaturePathIntent;
  /** Operator-facing overlay trust level (e.g. `overlay-complete`, `degraded-overlay`). */
  overlayTrustLevel: string;
  resolution: FeaturePathResolution;
  target: FeaturePathTarget | null;
  primaryAnswer: FeaturePathPrimaryAnswer;
  ownership: FeaturePathOwnership | null;
  contracts: FeaturePathContracts | null;
  directEvidence: FeaturePathDirectEvidenceItem[];
  context: FeaturePathContextItem[];
  /** At most ONE bounded operational hop where it materially completes the answer. */
  downstreamStep: FeaturePathDownstreamStep | null;
  crossLanguage: FeaturePathCrossLanguage | null;
  trust: FeaturePathTrust;
  /**
   * Failure classifications. Empty when the retrieval view is fully proven. A
   * non-empty `failures` does not preclude a partial summary — partial evidence
   * packets with explicit failure context are preferred over silent omission.
   */
  failures: FeaturePathFailure[];
}
