import type { ConfidenceClass } from '../../db/types.js';
import type { OperationalBoundary } from '../../db/types.js';

// ── Options (from CLI / MCP) ───────────────────────────────────────────────

export interface DeltaOptions {
  /** Diff baseline ref/SHA. Default: the index's last_indexed_commit (Decision 1). */
  base?: string;
  /** Exclude uncommitted working-tree changes (Decision 5). */
  committedOnly?: boolean;
  /** Reverse-walk depth budget (default 6, Decision 4). */
  depth: number;
  /** Reverse-walk node budget (default 2000). */
  maxNodes: number;
  /** Reverse-walk fanout cap (default 64, reused from trace). */
  maxFanout: number;
  /** Lowest confidence class to follow (default 'framework-inferred'). */
  minConfidence: ConfidenceClass;
  /** Gate mode (Decision 6). */
  check?: boolean;
  /** Comma-separated gate categories, overrides lux.yaml delta.gates (Decision 7). */
  failOn?: string[];
  /** Phase 4: sibling .lux index at the base ref for true overlay-vs-overlay diff. */
  baselineDb?: string;
  /** Emit the machine envelope instead of text. */
  json?: boolean;
}

// ── Change set (Phase 1) ───────────────────────────────────────────────────

export type DeltaFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
export type IndexTrust = 'index-fresh' | 'index-stale' | 'index-absent';

export interface DeltaFile {
  /** Current repo-relative path (post-rename for renames). Consumers act on this. */
  path: string;
  status: DeltaFileStatus;
  /** Rename ORIGIN — the path the index's facts are keyed under (Decision 12). */
  renamedFrom?: string;
  /** Module rollup; '(unscoped)' for files outside module patterns (SC-2). */
  module: string | null;
  indexTrust: IndexTrust;
}

export interface DeltaChangeSet {
  base: { ref: string; sha: string | null; source: 'flag' | 'index' };
  head: { sha: string | null; workingTreeIncluded: boolean };
  files: DeltaFile[];
  /**
   * Repo-relative paths that drive the index joins: the rename ORIGIN for renamed files
   * (facts live under the old path, Decision 12), the path itself otherwise. Distinct from
   * `files[].path`, which drives module resolution and reporting.
   */
  indexPaths: string[];
  warnings: string[];
}

// ── Touch set (Phase 1) ────────────────────────────────────────────────────

export interface TouchedNode {
  id: string;
  nodeType: string;
  filePath: string | null;
  qualifiedName: string | null;
  /** 'orphaned' when the declaring file was deleted but the node still exists (Decision 3). */
  nodeState: 'present' | 'orphaned';
}

export interface DeltaTouchSet {
  nodes: TouchedNode[];
  /** Touched symbol node ids — the reverse-walk seed and operational-join key. */
  symbolIds: string[];
  surfacesDeclared: TouchedNode[];
  evidenceEdgeCount: number;
  operationalBoundaries: OperationalBoundary[];
  orphanedNodeCount: number;
}

// ── Downstream (Phase 2a/2b) ───────────────────────────────────────────────

export interface EntrySurfaceImpact {
  kind: 'http' | 'command' | 'job' | 'schedule' | 'event';
  id: string;
  resolvedVia: 'structural-walk' | 'operational-join';
  /** Hop count from a touched symbol to the surface (structural-walk only). */
  hops?: number;
  /** Weakest confidence class on the resolving path; null for a direct operational join. */
  weakestConfidence: ConfidenceClass | null;
}

export interface AsyncBoundary {
  symbol: string;
  reachedVia: 'async-boundary';
}

// ── Ownership (Phase 2b) ───────────────────────────────────────────────────

export interface OwnershipTransition {
  route: string;
  label: string;
  changedHandler: string;
}

export interface OwnershipProjection {
  kernelConfigured: boolean;
  kernelResolved: boolean;
  source: 'cross-area-recompute' | 'single-index' | 'unavailable';
  kernelDrift: { indexedCommit: string | null; headCommit: string | null; stale: boolean } | null;
  transitions: OwnershipTransition[];
  /** Non-fatal reason ownership could not be computed (analysis mode surfaces it). */
  warning?: string;
}

// ── Spec-evidence (Phase 2b) ───────────────────────────────────────────────

export interface SpecTarget {
  kind: 'route' | 'handler' | 'job' | 'listener' | 'command';
  target: string;
}

// ── Gate (Phase 3) ─────────────────────────────────────────────────────────

export interface GateViolation {
  category: string;
  severity: 'blocking';
  subject: string;
  detail: string;
  evidence?: { file?: string; line?: number };
}

export interface GateResult {
  mode: 'check';
  exitCode: 0 | 1;
  violations: GateViolation[];
}

// ── Baseline diff (Phase 4) ────────────────────────────────────────────────

export interface BaselineDiff {
  surfacesRemoved: string[];
  surfacesAdded: string[];
  crossModuleEdgesAdded: Array<{ source: string; target: string; edgeType: string }>;
}

// ── The report ─────────────────────────────────────────────────────────────

/** The report's changeSet is the trimmed public projection of DeltaChangeSet — `indexPaths` and
 *  `warnings` are internal to resolution and never appear in the frozen envelope. */
export type ReportChangeSet = Pick<DeltaChangeSet, 'base' | 'head' | 'files'>;

export interface DeltaReportV1 {
  schemaVersion: 1;
  surface: 'delta';
  changeSet: ReportChangeSet;
  touched: {
    files: number;
    symbols: number;
    surfacesDeclared: number;
    evidenceEdges: number;
    orphanedNodes: number;
    symbolSample: string[];
  };
  downstream: {
    entrySurfaces: EntrySurfaceImpact[];
    asyncBoundaries: AsyncBoundary[];
    budget: { depth: number; maxNodes: number; truncated: boolean };
  };
  modules: { changed: string[]; dependents: Array<{ module: string; referenceCount: number }> };
  ownership: OwnershipProjection;
  invalidatedEvidence: { specTargets: SpecTarget[] };
  trust: {
    overlay: string;
    indexedCommit: string | null;
    staleFiles: number;
    absentFiles: number;
    warnings: string[];
  };
  gate?: GateResult; // present only with --check
  baselineDiff?: BaselineDiff; // present only with --baseline-db (Phase 4)
}

// ── Structured refusals (Decision 14/18) ───────────────────────────────────

export interface DeltaRefusal {
  reason:
    | 'db-absent'
    | 'schema-stale'
    | 'no-overlay'
    | 'not-a-git-repo'
    | 'baseline-unavailable'
    | 'config-error';
  message: string;
  remediation?: string;
}
