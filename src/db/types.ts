// Database entity types

export interface KnowledgeEntry {
  id: number;
  type: string;
  title: string;
  file_path: string;
  tags?: string; // JSON array
  metadata?: string; // JSON string
  content?: string; // Markdown content
  created_at: number;
  updated_at: number;
}

export interface Event {
  id: number;
  timestamp: number;
  source: string;
  source_id?: string;
  event_type: string;
  summary?: string;
  payload?: string; // JSON string
}

// Input types for insertions (without auto-generated fields)
export interface KnowledgeEntryInsert {
  type: string;
  title: string;
  file_path: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  content?: string;
}

export interface EventInsert {
  source: string;
  source_id?: string;
  event_type: string;
  summary?: string;
  payload?: Record<string, unknown>;
}

export interface Expert {
  id: number;
  slug: string;
  name: string;
  mount_path: string;
  model: string;
  /** Runtime backend used to execute this expert. Legacy rows may leave this unset. */
  backend?: string;
  /** Runtime provider for Pi-backed experts. */
  provider?: string;
  /** Runtime thinking level for Pi-backed experts. */
  thinking?: string;
  claude_md_path?: string;
  memory_path?: string;
  status: string;
  created_at: number;
  updated_at: number;
  /** Whether this expert's boundary is directory-led, overlay-led, or hybrid. */
  boundary_basis?: string;
  /** JSON-serialized ExpertStructuralSignature. */
  structural_signature?: string;
  /** Human-readable structural rationale from the proposal that created this expert. */
  structural_rationale?: string;
}

export interface ExpertInsert {
  slug: string;
  name: string;
  mount_path: string;
  model?: string;
  backend?: string;
  provider?: string;
  thinking?: string;
  claude_md_path?: string;
  memory_path?: string;
  status?: string;
  /** Whether this expert's boundary is directory-led, overlay-led, or hybrid. */
  boundary_basis?: string;
  /** JSON-serialized ExpertStructuralSignature. */
  structural_signature?: string;
  /** Human-readable structural rationale from the proposal that created this expert. */
  structural_rationale?: string;
}

export interface ExpertSession {
  id: number;
  expert_id: number;
  session_ref: string;
  spawned_at: number;
  last_active_at: number;
  status: string;
}

export interface ExpertSessionInsert {
  expert_id: number;
  session_ref: string;
  status?: string;
}

/** Index metadata key-value pair for tracking index state. */
export interface IndexMetadata {
  key: string;
  value: string;
  updated_at: number;
}

export interface ModuleDependency {
  id: number;
  source_module: string;
  target_module: string;
  reference_count: number;
  sample_files: string | null;
  created_at: number;
}

/** Unified search result from querying across all FTS5 tables. */
export interface DocumentSearchResult {
  file_path: string;
  title: string;
  content?: string;
  rank: number;
}

// ---------------------------------------------------------------------------
// Structural overlay types (migration 008)
// ---------------------------------------------------------------------------

export type StructuralNodeType =
  | 'file'
  | 'symbol'
  | 'route'
  | 'template'
  | 'contract'
  | 'event'
  | 'artifact'
  | 'capability-surface';

export type EdgeType =
  // Legacy overlay edges (kept for backwards compatibility)
  | 'calls_endpoint'
  | 'maps_route_to_consumer'
  | 'renders_template'
  | 'hydrates_component'
  | 'uses_generated_type'
  | 'implements_contract'
  | 'emits_event'
  | 'subscribes_event'
  | 'shares_config_key'
  // Capability-surface edges
  | 'declares_surface'
  | 'handled_by'
  | 'calls_surface'
  | 'uses_contract'
  | 'returns_contract'
  | 'validates_with'
  | 'derived_from'
  | 'calls'
  | 'references'
  // Module-boundary evidence expansion edges
  | 'dispatches_job'
  | 'handles_job'
  | 'listens_event'
  | 'resolves_service'
  | 'binds_service'
  | 'provides_capability'
  | 'imports_pipeline_artifact'
  | 'exports_pipeline_artifact'
  | 'syncs_external_record'
  | 'consumes_reporting_source'
  | 'transforms_model'
  | 'uses_contract_family'
  | 'emits_resource_family'
  | 'validates_contract_family'
  | 'shares_contract_family'
  | 'shares_schema_family'
  | 'projects_through_glue'
  | 'transits_shared_entrypoint';

export type ConfidenceClass = 'proven' | 'artifact-backed' | 'framework-inferred' | 'heuristic';

export type FreshnessStatus = 'fresh' | 'stale' | 'dirty-dependent' | 'unknown';

/**
 * Provenance of a structural node (ADR-3). 'local' = materialized from the
 * scanned project corpus; 'vendor-pack' = imported from a merged vendor pack.
 * Defaults to 'local' for every project-materialized node (migration 012).
 */
export type NodeOrigin = 'local' | 'vendor-pack';

export interface StructuralNode {
  id: string;
  node_type: StructuralNodeType;
  file_path?: string;
  language_id?: string;
  symbol_name?: string;
  symbol_kind?: string;
  qualified_name?: string;
  metadata?: string;
  /** Provenance. Defaults to 'local' for all project-materialized nodes (ADR-3). */
  origin?: NodeOrigin;
  updated_at: number;
}

export interface StructuralEdge {
  id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: EdgeType;
  confidence: number;
  confidence_class: ConfidenceClass;
  freshness_status: FreshnessStatus;
  source_commit?: string;
  dirty_dependency_count: number;
  provenance_summary?: string;
  updated_at: number;
}

export interface EdgeEvidence {
  id: string;
  edge_id: string;
  resolver: string;
  evidence_kind: string;
  file_path?: string;
  line?: number;
  note?: string;
  payload_json?: string;
  recorded_at: number;
}

// ---------------------------------------------------------------------------
// Operational boundary intelligence types (migration 011)
// ---------------------------------------------------------------------------

export type TrustTier = 1 | 2 | 3 | 4 | 5;

export type OperationalBoundaryKind = 'command' | 'schedule' | 'job' | 'event' | 'http';

export type OperationalEdgeType =
  'TRIGGERS' | 'HANDLED_BY' | 'DISPATCHES' | 'CONSUMES' | 'PRODUCES';

export type OperationalTransport = 'sync' | 'async' | 'queue' | 'event-bus';

export interface OperationalBoundary {
  id: string;
  repo_root: string;
  kind: OperationalBoundaryKind;
  name: string;
  trust_tier: TrustTier;
  file_path?: string;
}

export interface OperationalHandler {
  id: string;
  boundary_id: string;
  symbol_id: string;
  trust_tier: TrustTier;
}

export interface OperationalEdge {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: OperationalEdgeType;
  transport?: OperationalTransport;
  trust_tier: TrustTier;
}

export interface OperationalContract {
  id: string;
  boundary_id: string;
  payload_schema?: string;
  trust_tier: TrustTier;
}
