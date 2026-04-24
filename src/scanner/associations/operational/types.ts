import type {
  OperationalBoundaryKind,
  OperationalEdgeType,
  OperationalTransport,
  TrustTier,
} from '../../../db/types.js';
import type { AssociationContext } from '../types.js';

export type {
  OperationalBoundaryKind,
  OperationalEdgeType,
  OperationalTransport,
  TrustTier,
} from '../../../db/types.js';

export interface OperationalBoundaryDescriptor {
  id: string;
  repo_root: string;
  kind: OperationalBoundaryKind;
  name: string;
  trust_tier: TrustTier;
  file_path?: string;
}

export interface OperationalHandlerDescriptor {
  id: string;
  boundary_id: string;
  symbol_id: string;
  trust_tier: TrustTier;
}

export interface OperationalEdgeDescriptor {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: OperationalEdgeType;
  transport?: OperationalTransport;
  trust_tier: TrustTier;
}

export interface OperationalContractDescriptor {
  id: string;
  boundary_id: string;
  payload_schema?: string;
  trust_tier: TrustTier;
}

export interface OperationalExtractionBatch {
  boundaries: OperationalBoundaryDescriptor[];
  handlers: OperationalHandlerDescriptor[];
  edges: OperationalEdgeDescriptor[];
  contracts: OperationalContractDescriptor[];
}

export interface OperationalExtractor {
  readonly name: string;
  supports(context: AssociationContext): boolean;
  extract(context: AssociationContext): Promise<OperationalExtractionBatch>;
}

export function emptyOperationalBatch(): OperationalExtractionBatch {
  return {
    boundaries: [],
    handlers: [],
    edges: [],
    contracts: [],
  };
}

export function operationalBoundaryId(kind: OperationalBoundaryKind, name: string): string {
  return `opb:${kind}:${name}`;
}

export function operationalHandlerId(boundaryId: string, symbolId: string): string {
  return `oph:${boundaryId}:${symbolId}`;
}

export function operationalEdgeId(
  sourceId: string,
  targetId: string,
  edgeType: OperationalEdgeType,
  transport?: OperationalTransport
): string {
  return `ope:${sourceId}:${edgeType}:${targetId}${transport ? `:${transport}` : ''}`;
}

export function operationalContractId(boundaryId: string, label = 'default'): string {
  return `opc:${boundaryId}:${label}`;
}
