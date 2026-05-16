import { createHash } from 'node:crypto';
import type { LuxDatabase } from '../../../db/index.js';
import type {
  OperationalBoundary,
  OperationalContract,
  OperationalEdge,
} from '../../../db/types.js';
import {
  inspectOverlayTrustState,
  deriveOverlayTrustLevelFromState,
} from '../../overlay-trust-state.js';
import { assembleFeaturePathAnswer } from '../feature-path/assemble.js';
import type { FeaturePathResolution } from '../feature-path/contract.js';
import {
  getOperationalDispatchSourcesForJob,
  getOperationalDispatchedJobs,
  getOperationalEventListeners,
  getOperationalUpstreamTriggers,
  getTrustAwareOperationalNeighborhood,
} from '../operational/retrieval.js';
import type {
  SpecDerivationAskInput,
  SpecDerivationCandidateOperation,
  SpecDerivationEvidenceClaim,
  SpecDerivationEvidencePacketV1,
  SpecDerivationReviewPrompt,
  SpecDerivationTrustState,
} from './contract.js';
import { buildSpecEvidenceClaim, pathEvidenceRef, symbolEvidenceRef } from './evidence.js';
import { classifyDecisionClaimType, classifyMutationKind } from './mutations.js';
import { resolveSpecDerivationTarget, type ResolvedSpecDerivationTarget } from './resolve.js';
import {
  createSpecDerivationCoverage,
  markSignalFound,
  markUnsupportedFirstTrancheSignals,
} from './signals.js';
import { classifySpecDerivationSufficiency } from './sufficiency.js';

function hashPath(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function trustState(db: LuxDatabase): {
  state: SpecDerivationTrustState;
  warnings: string[];
  commit?: string;
} {
  const inspection = inspectOverlayTrustState(db);
  const level = deriveOverlayTrustLevelFromState(inspection.state);
  const state: SpecDerivationTrustState =
    level === 'overlay-complete'
      ? 'fresh'
      : level === 'stale-overlay'
        ? 'stale'
        : level === 'degraded-overlay'
          ? 'degraded'
          : level === 'content-only'
            ? 'content-only'
            : level === 'no-overlay'
              ? 'absent'
              : 'unknown';
  return {
    state,
    warnings:
      inspection.state?.warnings ??
      (inspection.source === 'none' ? ['No overlay trust state found.'] : []),
    commit: inspection.state?.lastIndexedCommit,
  };
}

function directRefForEdge(edge: OperationalEdge, summary: string) {
  return {
    kind: 'operational-edge' as const,
    summary: `${summary}: ${edge.edge_type}${edge.transport ? ` via ${edge.transport}` : ''} (tier ${edge.trust_tier})`,
    evidenceStrength: edge.trust_tier >= 4 ? ('direct' as const) : ('contextual' as const),
  };
}

function contractClaims(contracts: OperationalContract[]): SpecDerivationEvidenceClaim[] {
  return contracts.map((contract) =>
    buildSpecEvidenceClaim({
      claimType: 'data_input',
      sourceFact: `Operational contract ${contract.id} is persisted for boundary ${contract.boundary_id}.`,
      support: contract.trust_tier >= 4 ? 'direct' : 'contextual',
      evidence: [
        {
          kind: 'operational-contract',
          summary: contract.payload_schema
            ? `Persisted payload schema: ${contract.payload_schema.slice(0, 180)}`
            : 'Persisted operational contract without payload schema.',
          evidenceStrength: contract.trust_tier >= 4 ? 'direct' : 'contextual',
        },
      ],
    })
  );
}

function featurePathClaims(
  db: LuxDatabase,
  resolved: ResolvedSpecDerivationTarget,
  question: string,
  corpusPath: string
): {
  candidateOperation: SpecDerivationCandidateOperation;
  stateChanges: SpecDerivationEvidenceClaim[];
  decisionLogic: SpecDerivationEvidenceClaim[];
  dataFlow: SpecDerivationEvidenceClaim[];
  operationalEffects: SpecDerivationEvidenceClaim[];
  supportingContext: SpecDerivationEvidenceClaim[];
} {
  const routeSurface = resolved.routeSurface;
  const targetId = routeSurface?.id ?? resolved.featurePath?.surface.id;
  const featureResolution: FeaturePathResolution = {
    query: resolved.target.identifier,
    status: targetId ? 'resolved' : 'unresolved',
    candidates: targetId
      ? [
          {
            kind: 'route-surface',
            id: targetId,
            label:
              routeSurface?.symbol_name ?? resolved.featurePath?.surface.symbol_name ?? targetId,
            filePath: routeSurface?.file_path ?? resolved.featurePath?.surface.file_path ?? null,
          },
        ]
      : [],
  };
  const answer = assembleFeaturePathAnswer(db, {
    question,
    intent: 'route-handler',
    resolution: featureResolution,
    repoRoot: corpusPath,
  });

  const entrySurfaces = answer.directEvidence
    .filter((item) => item.kind === 'route-declaration')
    .map((item) =>
      buildSpecEvidenceClaim({
        claimType: 'entry_surface',
        sourceFact: item.description,
        support: 'direct',
        evidence: [pathEvidenceRef(item.filePath, item.description, 'overlay-boundary', 'direct')],
      })
    );
  const handlerClaims = answer.directEvidence
    .filter((item) => item.kind === 'handler-recovery')
    .map((item) =>
      buildSpecEvidenceClaim({
        claimType: 'handler',
        sourceFact: item.description,
        support: item.trustTier && item.trustTier < 4 ? 'contextual' : 'direct',
        evidence: item.nodeId
          ? [symbolEvidenceRef(item.nodeId, item.description, item.filePath)]
          : [pathEvidenceRef(item.filePath, item.description, 'file', 'contextual')],
      })
    );
  const decisionLogic = answer.directEvidence
    .filter((item) => item.kind === 'validator-attachment')
    .map((item) =>
      buildSpecEvidenceClaim({
        claimType: 'validation',
        sourceFact: item.description,
        support: 'direct',
        evidence: [pathEvidenceRef(item.filePath, item.description)],
      })
    );
  const dataFlow = answer.directEvidence
    .filter((item) => item.kind === 'response-contract')
    .map((item) =>
      buildSpecEvidenceClaim({
        claimType: 'response_field',
        sourceFact: item.description,
        support: 'direct',
        evidence: [pathEvidenceRef(item.filePath, item.description)],
      })
    );
  const operationalEffects = answer.downstreamStep
    ? [
        buildSpecEvidenceClaim({
          claimType: 'side_effect',
          sourceFact: answer.downstreamStep.description,
          support: answer.downstreamStep.trustTier >= 4 ? 'direct' : 'contextual',
          possibleInterpretation: 'This may indicate downstream operational work for review.',
          mutationKind: classifyMutationKind(answer.downstreamStep.description),
          evidence: [
            {
              kind: 'operational-edge',
              summary: `${answer.downstreamStep.edgeType} to ${answer.downstreamStep.target.label ?? answer.downstreamStep.target.id}`,
              evidenceStrength: answer.downstreamStep.trustTier >= 4 ? 'direct' : 'contextual',
            },
          ],
        }),
      ]
    : [];
  const supportingContext = answer.context.map((item) =>
    buildSpecEvidenceClaim({
      claimType: 'naming_convention',
      sourceFact: item.description,
      support: 'weak',
      evidence: [pathEvidenceRef(item.filePath, item.description, 'naming', 'weak')],
    })
  );

  return {
    candidateOperation: {
      label: answer.target?.label ?? resolved.target.identifier,
      labelSupport: entrySurfaces.length || handlerClaims.length ? 'direct' : 'weak',
      entrySurfaces,
    },
    stateChanges: operationalEffects.filter((claim) => claim.mutationKind !== undefined),
    decisionLogic,
    dataFlow,
    operationalEffects: [...handlerClaims, ...operationalEffects],
    supportingContext,
  };
}

function operationalClaims(
  db: LuxDatabase,
  boundary: OperationalBoundary,
  resolved: ResolvedSpecDerivationTarget
) {
  const handlers = db.getOperationalHandlersForBoundary(boundary.id);
  const contracts = db.getOperationalContractsForBoundary(boundary.id);
  const upstream = getOperationalUpstreamTriggers(db, boundary.id)?.triggers ?? [];
  const dispatchedJobs = getOperationalDispatchedJobs(db, boundary.id).dispatchedJobs;
  const dispatchSources =
    boundary.kind === 'job'
      ? (getOperationalDispatchSourcesForJob(db, boundary.id)?.dispatchSources ?? [])
      : [];
  const listeners =
    boundary.kind === 'event'
      ? (getOperationalEventListeners(db, boundary.id)?.listeners ?? [])
      : [];
  const neighborhood = getTrustAwareOperationalNeighborhood(db, boundary.id, {
    maxDepth: 1,
    minTrustTier: 1,
  });

  const entrySurfaces = [
    buildSpecEvidenceClaim({
      claimType: 'entry_surface',
      sourceFact: `Operational boundary ${boundary.kind}:${boundary.name} is persisted.`,
      support: boundary.trust_tier >= 4 ? 'direct' : 'contextual',
      evidence: [
        pathEvidenceRef(
          boundary.file_path,
          `Operational boundary ${boundary.id}`,
          'overlay-boundary'
        ),
      ],
    }),
  ];
  const handlerClaims = handlers.map((handler) =>
    buildSpecEvidenceClaim({
      claimType: 'handler',
      sourceFact: `Boundary ${boundary.id} is handled by ${handler.symbol_id}.`,
      support: handler.trust_tier >= 4 ? 'direct' : 'contextual',
      evidence: [symbolEvidenceRef(handler.symbol_id, `Handler for ${boundary.id}`)],
    })
  );
  const contractData = contractClaims(contracts);
  const upstreamClaims = upstream.map((entry) =>
    buildSpecEvidenceClaim({
      claimType: entry.sourceBoundary.kind === 'schedule' ? 'side_effect' : 'entry_surface',
      sourceFact: `${entry.sourceBoundary.kind}:${entry.sourceBoundary.name} triggers ${boundary.kind}:${boundary.name}.`,
      support: entry.edge.trust_tier >= 4 ? 'direct' : 'contextual',
      mutationKind: entry.sourceBoundary.kind === 'schedule' ? 'unknown_side_effect' : undefined,
      evidence: [directRefForEdge(entry.edge, 'Upstream trigger')],
    })
  );
  const dispatchSourceClaims = dispatchSources.map((entry) =>
    buildSpecEvidenceClaim({
      claimType: 'side_effect',
      sourceFact: `${entry.edge.source_id} dispatches job ${boundary.name}.`,
      support: entry.edge.trust_tier >= 4 ? 'direct' : 'contextual',
      mutationKind: 'job_dispatch',
      evidence: [directRefForEdge(entry.edge, 'Job dispatch source')],
    })
  );
  const dispatchedJobClaims = dispatchedJobs.map((entry) =>
    buildSpecEvidenceClaim({
      claimType: 'side_effect',
      sourceFact: `${boundary.kind}:${boundary.name} dispatches job ${entry.jobBoundary.name}.`,
      support: entry.edge.trust_tier >= 4 ? 'direct' : 'contextual',
      mutationKind: 'job_dispatch',
      evidence: [directRefForEdge(entry.edge, 'Dispatched job')],
    })
  );
  const listenerClaims = listeners.map((entry) =>
    buildSpecEvidenceClaim({
      claimType: 'side_effect',
      sourceFact: `${entry.handler.symbol_id} handles event ${boundary.name}.`,
      support: entry.edge.trust_tier >= 4 ? 'direct' : 'contextual',
      mutationKind: 'event_emit',
      evidence: [directRefForEdge(entry.edge, 'Event listener')],
    })
  );
  const contextClaims = neighborhood.edges.slice(0, 5).map((edge) =>
    buildSpecEvidenceClaim({
      claimType: 'implicit_constraint',
      sourceFact: `Operational neighborhood edge ${edge.sourceId} -> ${edge.targetId} uses ${edge.edgeType}.`,
      support: edge.trustTier >= 4 ? 'contextual' : 'weak',
      evidence: [
        {
          kind: 'operational-edge',
          summary: `${edge.edgeType} neighborhood edge ${edge.id}`,
          evidenceStrength: edge.trustTier >= 4 ? 'contextual' : 'weak',
        },
      ],
    })
  );

  return {
    candidateOperation: {
      label: resolved.target.candidates[0]?.label ?? `${boundary.kind}:${boundary.name}`,
      labelSupport: supportFromBoundary(boundary),
      entrySurfaces,
    },
    stateChanges: [
      ...dispatchSourceClaims,
      ...dispatchedJobClaims,
      ...listenerClaims,
      ...upstreamClaims,
    ].filter((claim) => claim.mutationKind),
    decisionLogic: contextClaims
      .filter((claim) => /config|guard|retry|idempotent|branch/i.test(claim.sourceFact))
      .map((claim) => ({ ...claim, claimType: classifyDecisionClaimType(claim.sourceFact) })),
    dataFlow: contractData,
    operationalEffects: [
      ...handlerClaims,
      ...upstreamClaims,
      ...dispatchSourceClaims,
      ...dispatchedJobClaims,
      ...listenerClaims,
    ],
    supportingContext: contextClaims,
  };
}

function supportFromBoundary(boundary: OperationalBoundary) {
  return boundary.trust_tier >= 4 ? ('direct' as const) : ('contextual' as const);
}

function buildReviewPrompts(
  sufficiencyMissing: string[],
  conflicting: string[],
  packetTracks: {
    stateChanges: SpecDerivationEvidenceClaim[];
    decisionLogic: SpecDerivationEvidenceClaim[];
    dataFlow: SpecDerivationEvidenceClaim[];
    operationalEffects: SpecDerivationEvidenceClaim[];
  }
): SpecDerivationReviewPrompt[] {
  const prompts: SpecDerivationReviewPrompt[] = [];
  for (const missing of sufficiencyMissing) {
    prompts.push({
      topic: 'missing-evidence',
      reason: missing,
      questionForSpecSystem:
        'Does the downstream specification process need this missing evidence before drafting?',
    });
  }
  for (const conflict of conflicting) {
    prompts.push({
      topic: 'conflicting-evidence',
      reason: conflict,
      questionForSpecSystem:
        'Which source-grounded behavior should a specification reviewer treat as intentional?',
    });
  }
  if (packetTracks.stateChanges.length > 0 || packetTracks.operationalEffects.length > 0) {
    prompts.push({
      topic: 'side-effect-review',
      reason: 'Source evidence includes mutation or operational-effect claims.',
      questionForSpecSystem:
        'Which observed side effects are intentional behavior versus implementation detail?',
    });
  }
  return prompts;
}

export function assembleSpecDerivationEvidencePacket(
  db: LuxDatabase,
  input: SpecDerivationAskInput
): SpecDerivationEvidencePacketV1 {
  const resolved = resolveSpecDerivationTarget(db, {
    kind: input.kind,
    identifier: input.target,
    corpusPath: input.corpusPath,
  });
  const trust = trustState(db);
  const coverage = createSpecDerivationCoverage();
  markUnsupportedFirstTrancheSignals(coverage);

  const tracks =
    resolved.target.resolutionState === 'resolved' && resolved.operationalBoundary
      ? operationalClaims(db, resolved.operationalBoundary, resolved)
      : resolved.target.resolutionState === 'resolved'
        ? featurePathClaims(db, resolved, input.question, input.corpusPath)
        : {
            candidateOperation: {
              label: input.target,
              labelSupport: 'insufficient' as const,
              entrySurfaces: [],
            },
            stateChanges: [],
            decisionLogic: [],
            dataFlow: [],
            operationalEffects: [],
            supportingContext: [],
          };

  if (tracks.stateChanges.length > 0) {
    markSignalFound(
      coverage,
      tracks.stateChanges.some((claim) => claim.mutationKind === 'job_dispatch')
        ? 'job_dispatch'
        : 'database_write'
    );
  }
  if (tracks.decisionLogic.length > 0) markSignalFound(coverage, 'branch_condition');
  if (tracks.dataFlow.length > 0) markSignalFound(coverage, 'event_or_job_payload');
  if (tracks.operationalEffects.length > 0) markSignalFound(coverage, 'operational_handler');
  if (tracks.supportingContext.length > 0) markSignalFound(coverage, 'naming_evidence');
  if (tracks.candidateOperation.entrySurfaces.length > 0)
    markSignalFound(coverage, 'operational_neighborhood');

  const sufficiency = classifySpecDerivationSufficiency({
    target: resolved.target,
    stateChanges: tracks.stateChanges,
    decisionLogic: tracks.decisionLogic,
    dataFlow: tracks.dataFlow,
    operationalEffects: tracks.operationalEffects,
    supportingContext: tracks.supportingContext,
  });

  return {
    schemaVersion: 1,
    surface: 'spec-derivation-evidence',
    mode: 'retrieval',
    question: input.question,
    target: resolved.target,
    sourceScope: {
      corpusPathHash: hashPath(input.corpusPath),
      dbPathHash: input.dbPath ? hashPath(input.dbPath) : undefined,
      commit: trust.commit,
      trustState: trust.state,
      warnings: trust.warnings,
    },
    candidateOperation: tracks.candidateOperation,
    stateChanges: tracks.stateChanges,
    decisionLogic: tracks.decisionLogic,
    dataFlow: tracks.dataFlow,
    operationalEffects: tracks.operationalEffects,
    supportingContext: tracks.supportingContext,
    coverage,
    sufficiency,
    reviewPrompts: buildReviewPrompts(
      sufficiency.missingEvidence,
      sufficiency.conflictingEvidence,
      tracks
    ),
  };
}
