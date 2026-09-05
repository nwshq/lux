import type { CapabilityEvidenceV1, CapabilityState } from './types.js';

export type {
  CapabilityEvidenceV1,
  CapabilityState,
  CoverageCapability,
  LanguageCapabilityCoverageV1,
} from './types.js';

function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

export function deriveCapability(input: {
  producer: string;
  candidates: number;
  configured: boolean;
  ran: boolean;
  failures: number;
  nodes: number;
  edges: number;
  documentedSubset: boolean;
}): CapabilityEvidenceV1 {
  assertCount('candidates', input.candidates);
  assertCount('failures', input.failures);
  assertCount('nodes', input.nodes);
  assertCount('edges', input.edges);

  let state: CapabilityState;
  let reason: string | undefined;
  if (!input.configured) {
    state = input.candidates ? 'unsupported' : 'not_applicable';
    reason = input.candidates ? 'no producer configured' : 'no applicable candidates';
  } else if (!input.ran) {
    state = 'failed';
    reason = 'configured producer did not run';
  } else if (
    input.failures ||
    input.documentedSubset ||
    (input.candidates > 0 && input.nodes + input.edges === 0)
  ) {
    state = 'partial';
    reason = input.failures
      ? `${input.failures} producer failure(s)`
      : input.documentedSubset
        ? 'documented subset'
        : 'applicable candidates produced no structural output';
  } else {
    state = 'active';
  }
  return {
    state,
    producer: input.producer,
    nodes: input.nodes,
    edges: input.edges,
    failures: input.failures,
    ...(reason ? { reason } : {}),
  };
}
