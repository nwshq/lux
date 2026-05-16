export type SpecDerivationSupport =
  | 'direct'
  | 'contextual'
  | 'weak'
  | 'insufficient'
  | 'conflicting';

export type SpecDerivationSufficiency = 'sufficient' | 'partial' | 'insufficient' | 'conflicting';

export type SpecDerivationTrustState =
  | 'fresh'
  | 'stale'
  | 'degraded'
  | 'content-only'
  | 'absent'
  | 'unknown';

export type SpecDerivationTargetKind = 'route' | 'handler' | 'job' | 'listener' | 'command';

export type SpecDerivationResolutionKind = SpecDerivationTargetKind | 'event-context';

export type SpecDerivationClaimType =
  | 'entry_surface'
  | 'handler'
  | 'state_mutation'
  | 'side_effect'
  | 'validation'
  | 'authorization'
  | 'state_guard'
  | 'branch'
  | 'data_input'
  | 'entity_read'
  | 'entity_mutation'
  | 'emitted_payload'
  | 'implicit_constraint'
  | 'feature_flag'
  | 'exception_path'
  | 'early_return'
  | 'retry_or_backoff'
  | 'idempotency_guard'
  | 'configuration_dependency'
  | 'relationship_traversal'
  | 'response_field'
  | 'derived_field'
  | 'supporting_test'
  | 'supporting_doc'
  | 'naming_convention';

export type SpecDerivationMutationKind =
  | 'create'
  | 'update'
  | 'delete'
  | 'read_for_mutation'
  | 'transaction_boundary'
  | 'event_emit'
  | 'job_dispatch'
  | 'external_mutation'
  | 'file_or_object_write'
  | 'unknown_side_effect';

export interface SpecDerivationEvidencePacketV1 {
  schemaVersion: 1;
  surface: 'spec-derivation-evidence';
  mode: 'retrieval';
  question: string;
  target: SpecDerivationTarget;
  sourceScope: SpecDerivationSourceScope;
  candidateOperation: SpecDerivationCandidateOperation;
  stateChanges: SpecDerivationEvidenceClaim[];
  decisionLogic: SpecDerivationEvidenceClaim[];
  dataFlow: SpecDerivationEvidenceClaim[];
  operationalEffects: SpecDerivationEvidenceClaim[];
  supportingContext: SpecDerivationEvidenceClaim[];
  coverage: SpecDerivationCoverageBlock;
  sufficiency: SpecDerivationSufficiencyBlock;
  reviewPrompts: SpecDerivationReviewPrompt[];
}

export interface SpecDerivationTarget {
  kind: SpecDerivationTargetKind;
  identifier: string;
  location?: string;
  resolutionState: 'resolved' | 'ambiguous' | 'unresolved';
  resolvedNodeId?: string;
  candidates: SpecDerivationTargetCandidate[];
}

export interface SpecDerivationTargetCandidate {
  id: string;
  kind: SpecDerivationResolutionKind;
  label: string;
  filePath?: string | null;
  support: SpecDerivationSupport;
}

export interface SpecDerivationSourceScope {
  corpusPathHash: string;
  dbPathHash?: string;
  commit?: string;
  trustState: SpecDerivationTrustState;
  warnings: string[];
}

export interface SpecDerivationCandidateOperation {
  label?: string;
  labelSupport: SpecDerivationSupport;
  entrySurfaces: SpecDerivationEvidenceClaim[];
}

export interface SpecDerivationEvidenceClaim {
  claimId: string;
  claimType: SpecDerivationClaimType;
  sourceFact: string;
  possibleInterpretation?: string;
  support: SpecDerivationSupport;
  evidence: SpecDerivationEvidenceRef[];
  mutationKind?: SpecDerivationMutationKind;
}

export interface SpecDerivationEvidenceRef {
  kind:
    | 'symbol'
    | 'edge'
    | 'file'
    | 'line'
    | 'test'
    | 'doc'
    | 'naming'
    | 'overlay-boundary'
    | 'operational-edge'
    | 'operational-contract';
  path?: string;
  symbol?: string;
  lineStart?: number;
  lineEnd?: number;
  summary: string;
  evidenceStrength: 'direct' | 'contextual' | 'weak';
}

export type SpecDerivationSignalStatus = 'found' | 'missing' | 'unsupported' | 'not_applicable';

export type SpecDerivationStateChangeSignal =
  | 'database_write'
  | 'orm_mutation'
  | 'transaction_wrapper'
  | 'model_create_update_delete'
  | 'repository_save_delete'
  | 'job_dispatch'
  | 'event_emit'
  | 'listener_side_effect'
  | 'external_mutation'
  | 'file_or_object_write'
  | 'scheduler_or_command_mutation'
  | 'failure_rollback_or_compensation';

export type SpecDerivationDecisionLogicSignal =
  | 'validation_rule'
  | 'authorization_or_policy'
  | 'state_or_status_guard'
  | 'feature_flag'
  | 'branch_condition'
  | 'exception_path'
  | 'early_return_or_refusal'
  | 'retry_or_backoff'
  | 'idempotency_or_duplicate_prevention'
  | 'configuration_dependency'
  | 'linked_test_assertion';

export type SpecDerivationDataFlowSignal =
  | 'request_or_dto_field'
  | 'validation_schema_field'
  | 'entity_read_or_write'
  | 'relationship_traversal'
  | 'repository_or_service_parameter'
  | 'event_or_job_payload'
  | 'response_or_resource_field'
  | 'database_column_touched'
  | 'derived_or_computed_field'
  | 'implicit_code_constraint';

export type SpecDerivationOperationalEffectSignal =
  | 'dispatch_source'
  | 'handled_event'
  | 'scheduled_trigger'
  | 'operational_handler'
  | 'operational_contract'
  | 'operational_neighborhood';

export type SpecDerivationSupportingContextSignal =
  | 'test_evidence'
  | 'doc_evidence'
  | 'naming_evidence';

export interface SpecDerivationCoverageBlock {
  stateChangeSignals: Record<SpecDerivationStateChangeSignal, SpecDerivationSignalStatus>;
  decisionLogicSignals: Record<SpecDerivationDecisionLogicSignal, SpecDerivationSignalStatus>;
  dataFlowSignals: Record<SpecDerivationDataFlowSignal, SpecDerivationSignalStatus>;
  operationalEffectSignals: Record<
    SpecDerivationOperationalEffectSignal,
    SpecDerivationSignalStatus
  >;
  supportingContextSignals: Record<
    SpecDerivationSupportingContextSignal,
    SpecDerivationSignalStatus
  >;
}

export interface SpecDerivationSufficiencyBlock {
  overall: SpecDerivationSufficiency;
  canSupportSpecDraft: boolean;
  reasons: string[];
  missingEvidence: string[];
  conflictingEvidence: string[];
}

export interface SpecDerivationReviewPrompt {
  topic: string;
  reason: string;
  questionForSpecSystem: string;
}

export interface SpecDerivationAskInput {
  question: string;
  target: string;
  kind: SpecDerivationTargetKind;
  corpusPath: string;
  dbPath?: string;
}
