// Tranche-one bounded downstream step.
//
// The downstream slot in FeaturePathAnswer is intentionally limited to ONE
// hop (R8). When a feature question reaches a route handler, the next thing
// the operator usually wants to know is "what does this trigger?" — but only
// in the form of a single, materially-completing step. Anything beyond that
// stops being a feature answer and starts being a trace.
//
// Conservative on purpose:
//   - We look up edges where source_id is the recovered handler's exact
//     symbol id. We deliberately do NOT fall back to the controller class id,
//     because dispatches from sibling methods (`@destroy`, `@update`) would
//     pollute the answer and break "bounded".
//   - We filter to outbound emission edge types only: DISPATCHES, TRIGGERS,
//     PRODUCES. HANDLED_BY/CONSUMES are inverse/upstream and don't belong here.
//   - We pick the single strongest edge by trust_tier (deterministic id tiebreak).

import type { LuxDatabase } from '../../../db/index.js';
import type { OperationalEdge, OperationalEdgeType, StructuralNode } from '../../../db/types.js';
import type { FeaturePathDownstreamEndpoint, FeaturePathDownstreamStep } from './contract.js';

const DOWNSTREAM_EDGE_TYPES: ReadonlySet<OperationalEdgeType> = new Set<OperationalEdgeType>([
  'DISPATCHES',
  'TRIGGERS',
  'PRODUCES',
]);

export interface FindBoundedDownstreamStepInput {
  /** Recovered handler structural node, typically `FeaturePath.providers[0]`. */
  handler: StructuralNode | null;
}

/**
 * Find a single bounded downstream operational hop from a recovered handler.
 * Returns `null` when no qualifying edge exists; the assembler treats that as
 * "no downstream step", not a failure.
 */
export function findBoundedDownstreamStep(
  db: LuxDatabase,
  input: FindBoundedDownstreamStepInput
): FeaturePathDownstreamStep | null {
  const { handler } = input;
  if (!handler) return null;

  const candidates = db
    .getOperationalEdgesForSource(handler.id)
    .filter((edge) => DOWNSTREAM_EDGE_TYPES.has(edge.edge_type));

  if (candidates.length === 0) return null;

  candidates.sort(
    (left, right) => right.trust_tier - left.trust_tier || left.id.localeCompare(right.id)
  );

  const best = candidates[0];

  const handlerLabel = handler.symbol_name ?? lastSegment(handler.id);
  const source: FeaturePathDownstreamEndpoint = {
    id: handler.id,
    label: handlerLabel,
    ...(handler.file_path ? { filePath: handler.file_path } : {}),
  };

  const targetBoundary = db.getOperationalBoundary(best.target_id);
  const target: FeaturePathDownstreamEndpoint = {
    id: best.target_id,
    ...(targetBoundary?.name ? { label: targetBoundary.name } : {}),
    ...(targetBoundary?.file_path ? { filePath: targetBoundary.file_path } : {}),
  };

  const description = buildDescription({
    handlerLabel,
    edgeType: best.edge_type,
    transport: best.transport,
    targetLabel: target.label ?? target.id,
  });

  const rationale = buildRationale({
    edgeCount: candidates.length,
    edgeType: best.edge_type,
  });

  const step: FeaturePathDownstreamStep = {
    description,
    edgeType: best.edge_type,
    source,
    target,
    trustTier: best.trust_tier,
    rationale,
  };
  if (best.transport) {
    step.transport = best.transport;
  }
  return step;
}

function lastSegment(id: string): string {
  const colonIdx = id.lastIndexOf(':');
  return colonIdx >= 0 ? id.slice(colonIdx + 1) : id;
}

function buildDescription(input: {
  handlerLabel: string;
  edgeType: OperationalEdgeType;
  transport?: OperationalEdge['transport'];
  targetLabel: string;
}): string {
  const verb = edgeVerb(input.edgeType);
  const transportClause = input.transport ? ` via ${input.transport}` : '';
  return `${input.handlerLabel} ${verb} ${input.targetLabel}${transportClause}`;
}

function edgeVerb(edgeType: OperationalEdgeType): string {
  switch (edgeType) {
    case 'DISPATCHES':
      return 'dispatches';
    case 'TRIGGERS':
      return 'triggers';
    case 'PRODUCES':
      return 'produces';
    default:
      return edgeType.toLowerCase();
  }
}

function buildRationale(input: { edgeCount: number; edgeType: OperationalEdgeType }): string {
  if (input.edgeCount === 1) {
    return `The only persisted ${input.edgeType.toLowerCase()} edge from the recovered handler.`;
  }
  return `Strongest of ${input.edgeCount} persisted downstream edges from the recovered handler.`;
}
