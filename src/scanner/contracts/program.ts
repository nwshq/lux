import type { ConfidenceClass, EdgeType, StructuralEdge } from '../../db/types.js';
import type { LuxDatabase } from '../../db/index.js';

export type TraversalDirection = 'outgoing' | 'incoming' | 'both';

export interface TraceOptionsV2 {
  direction: TraversalDirection;
  maxDepth: number;
  maxNodes: number;
  maxFanout: number;
  edgeTypes: EdgeType[];
  minConfidenceClass: ConfidenceClass;
  includeExternal: boolean;
}

export interface TraversedStructuralEdge extends StructuralEdge {
  traversed: 'forward' | 'reverse';
}

export type IndexOpenMode = 'read-existing' | 'write-existing' | 'create-or-migrate';
export type IndexOpenRefusal =
  'index-absent' | 'schema-too-old' | 'schema-too-new' | 'db-unreadable';

export type IndexOpenResult =
  | { ok: true; db: LuxDatabase; schemaVersion: number }
  | { ok: false; refusal: IndexOpenRefusal; message: string };

export interface ReadTelemetryV1 {
  recorded: false;
  reason: 'read-only-index';
}

export type CapabilityState = 'active' | 'partial' | 'unsupported' | 'failed' | 'not_applicable';

export interface CapabilityEvidenceV1 {
  state: CapabilityState;
  producer: string;
  nodes: number;
  edges: number;
  failures: number;
  reason?: string;
}

export interface LanguageCapabilityCoverageV1 {
  schemaVersion: 1;
  languageId: string;
  files: number;
  symbolizedFiles: number;
  symbols: number;
  relatedSymbols: number;
  capabilities: Record<
    'syntax' | 'symbols' | 'imports' | 'calls' | 'references' | 'framework',
    CapabilityEvidenceV1
  >;
}

export interface SourceLocationV1 {
  filePath: string;
  line: number;
  column: number;
}

export interface DeclarationFactV1 {
  localId: string;
  kind: string;
  name: string;
  container?: string;
  location: SourceLocationV1;
}

export interface ReferenceFactV1 {
  fromLocalId: string;
  kind: 'call' | 'import' | 'export' | 'reference';
  rawTarget: string;
  member?: string;
  location: SourceLocationV1;
}

export interface SourceDiagnosticV1 {
  code: string;
  message: string;
  location?: SourceLocationV1;
}

export interface SourceFactsV1 {
  schemaVersion: 1;
  languageId: string;
  filePath: string;
  declarations: DeclarationFactV1[];
  references: ReferenceFactV1[];
  diagnostics: SourceDiagnosticV1[];
}

export interface AliasRuleV1 {
  pattern: string;
  targets: string[];
  source: 'tsconfig' | 'jsconfig' | 'vite' | 'workspace' | 'package-exports';
  configFile: string;
  precedence: number;
}

export interface WorkspacePackageV1 {
  name: string;
  rootPath: string;
  manifestPath: string;
  exports: Record<string, string[]>;
}

export interface ExportTargetV1 {
  localName: string;
  filePath: string;
  declarationId?: string;
}

export interface ModuleExportIndexV1 {
  default?: ExportTargetV1;
  named: Record<string, ExportTargetV1>;
  reexports: Array<{ exported: string; imported: string; specifier: string }>;
  /**
   * Direct declarations that conflict on one exported name. Unique exports remain in `default` or
   * `named`; a conflicting name is retained here so resolution can refuse as ambiguous instead of
   * silently overwriting evidence. The key `default` represents conflicting default exports.
   */
  conflicts?: Record<string, ExportTargetV1[]>;
}

export interface ProjectResolutionContextV1 {
  rootPath: string;
  sourceFiles: ReadonlySet<string>;
  aliases: readonly AliasRuleV1[];
  workspacePackages: readonly WorkspacePackageV1[];
  exportsByFile: ReadonlyMap<string, ModuleExportIndexV1>;
  fingerprintInputs: readonly string[];
}

export type ModuleResolutionResultV1 =
  | {
      status: 'resolved';
      targetFile: string;
      targetExport?: string;
      via: AliasRuleV1['source'] | 'relative';
      evidenceFile?: string;
    }
  | { status: 'external' | 'missing'; specifier: string }
  | { status: 'ambiguous'; candidates: string[]; governingConfigs: string[] };

export type ProgramEdgeType =
  | 'renders_component'
  | 'uses_composable'
  | 'uses_store'
  | 'emits_component_event'
  | 'handles_component_event'
  | 'navigates_to'
  | 'uses_hook'
  | 'provides_context'
  | 'consumes_context'
  | 'uses_view_model'
  | 'publishes_bus_event'
  | 'subscribes_bus_event'
  | 'declares_resource'
  | 'references_resource'
  | 'produces_artifact'
  | 'consumes_artifact'
  | 'invokes_workflow'
  | 'uses_base_image'
  | 'copies_artifact'
  | 'depends_on_service';

export interface RelationshipBenchmarkCaseV1 {
  id: string;
  corpus: string;
  capability: string;
  query?: { tool: string; args: Record<string, unknown> };
  expectedEdges: Array<{
    source: string;
    type: EdgeType | ProgramEdgeType;
    target: string;
    minConfidence: ConfidenceClass;
  }>;
  forbiddenEdges: Array<{ source?: string; type?: string; target?: string }>;
  expectedOutcome: 'answered' | 'refused' | 'unsupported';
  expectedRefusalReason?: string;
}
