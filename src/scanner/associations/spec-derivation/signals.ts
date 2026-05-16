import type {
  SpecDerivationCoverageBlock,
  SpecDerivationDataFlowSignal,
  SpecDerivationDecisionLogicSignal,
  SpecDerivationOperationalEffectSignal,
  SpecDerivationSignalStatus,
  SpecDerivationStateChangeSignal,
  SpecDerivationSupportingContextSignal,
} from './contract.js';

const STATE_CHANGE_SIGNALS: readonly SpecDerivationStateChangeSignal[] = [
  'database_write',
  'orm_mutation',
  'transaction_wrapper',
  'model_create_update_delete',
  'repository_save_delete',
  'job_dispatch',
  'event_emit',
  'listener_side_effect',
  'external_mutation',
  'file_or_object_write',
  'scheduler_or_command_mutation',
  'failure_rollback_or_compensation',
] as const;

const DECISION_LOGIC_SIGNALS: readonly SpecDerivationDecisionLogicSignal[] = [
  'validation_rule',
  'authorization_or_policy',
  'state_or_status_guard',
  'feature_flag',
  'branch_condition',
  'exception_path',
  'early_return_or_refusal',
  'retry_or_backoff',
  'idempotency_or_duplicate_prevention',
  'configuration_dependency',
  'linked_test_assertion',
] as const;

const DATA_FLOW_SIGNALS: readonly SpecDerivationDataFlowSignal[] = [
  'request_or_dto_field',
  'validation_schema_field',
  'entity_read_or_write',
  'relationship_traversal',
  'repository_or_service_parameter',
  'event_or_job_payload',
  'response_or_resource_field',
  'database_column_touched',
  'derived_or_computed_field',
  'implicit_code_constraint',
] as const;

const OPERATIONAL_EFFECT_SIGNALS: readonly SpecDerivationOperationalEffectSignal[] = [
  'dispatch_source',
  'handled_event',
  'scheduled_trigger',
  'operational_handler',
  'operational_contract',
  'operational_neighborhood',
] as const;

const SUPPORTING_CONTEXT_SIGNALS: readonly SpecDerivationSupportingContextSignal[] = [
  'test_evidence',
  'doc_evidence',
  'naming_evidence',
] as const;

function record<T extends string>(
  keys: readonly T[],
  status: SpecDerivationSignalStatus
): Record<T, SpecDerivationSignalStatus> {
  return Object.fromEntries(keys.map((key) => [key, status])) as Record<
    T,
    SpecDerivationSignalStatus
  >;
}

export function createSpecDerivationCoverage(
  defaultStatus: SpecDerivationSignalStatus = 'missing'
): SpecDerivationCoverageBlock {
  return {
    stateChangeSignals: record(STATE_CHANGE_SIGNALS, defaultStatus),
    decisionLogicSignals: record(DECISION_LOGIC_SIGNALS, defaultStatus),
    dataFlowSignals: record(DATA_FLOW_SIGNALS, defaultStatus),
    operationalEffectSignals: record(OPERATIONAL_EFFECT_SIGNALS, defaultStatus),
    supportingContextSignals: record(SUPPORTING_CONTEXT_SIGNALS, defaultStatus),
  };
}

export function markSignalFound(
  coverage: SpecDerivationCoverageBlock,
  signal:
    | SpecDerivationStateChangeSignal
    | SpecDerivationDecisionLogicSignal
    | SpecDerivationDataFlowSignal
    | SpecDerivationOperationalEffectSignal
    | SpecDerivationSupportingContextSignal
): void {
  if (signal in coverage.stateChangeSignals) {
    coverage.stateChangeSignals[signal as SpecDerivationStateChangeSignal] = 'found';
  } else if (signal in coverage.decisionLogicSignals) {
    coverage.decisionLogicSignals[signal as SpecDerivationDecisionLogicSignal] = 'found';
  } else if (signal in coverage.dataFlowSignals) {
    coverage.dataFlowSignals[signal as SpecDerivationDataFlowSignal] = 'found';
  } else if (signal in coverage.operationalEffectSignals) {
    coverage.operationalEffectSignals[signal as SpecDerivationOperationalEffectSignal] = 'found';
  } else {
    coverage.supportingContextSignals[signal as SpecDerivationSupportingContextSignal] = 'found';
  }
}

export function markUnsupportedFirstTrancheSignals(coverage: SpecDerivationCoverageBlock): void {
  coverage.stateChangeSignals.failure_rollback_or_compensation = 'unsupported';
  coverage.decisionLogicSignals.linked_test_assertion = 'unsupported';
  coverage.dataFlowSignals.database_column_touched = 'unsupported';
  coverage.dataFlowSignals.derived_or_computed_field = 'unsupported';
}
