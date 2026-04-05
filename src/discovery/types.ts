import type { LuxDatabase } from '../db/index.js';
import type { ModuleDependency } from '../db/types.js';
import type { ModuleCluster } from '../db/clustering.js';

// ── Discovery Options ──────────────────────────────────────

export interface DiscoveryOptions {
  /** Absolute path to the content root directory. */
  rootPath: string;
  /** AI model for analysis (default: claude-sonnet-4-20250514). */
  model?: string;
  /** Show proposals without registering. */
  dryRun?: boolean;
  /** Output proposals as JSON and skip interactive review. */
  json?: boolean;
  /** Maximum number of experts to propose (default: 20). */
  maxExperts?: number;
  /** Minimum confidence threshold 0.0–1.0 (default: 0.5). */
  minConfidence?: number;
  /** Accept all proposals without interactive review. */
  acceptAll?: boolean;
  /** Only show proposals that differ from current experts. */
  diff?: boolean;
}

// ── Tree Collection ────────────────────────────────────────

export interface TreeOptions {
  /** Maximum directory depth to traverse (default: 8). */
  maxDepth?: number;
  /** Maximum total entries before truncation (default: 500). */
  maxEntries?: number;
}

// ── Discovery Context (Stage 2 output) ─────────────────────

export interface DiscoveryContext {
  /** Directory tree string from Stage 1. */
  tree: string;
  /** Number of indexed files per directory path. */
  fileCountsByDirectory: Record<string, number>;
  /** Top symbol names per directory (from LSP, when available). */
  symbolSummaries?: Record<string, string[]>;
  /** Cross-directory references (from LSP, when available). */
  crossReferences?: CrossReference[];
  /** Already-registered experts to avoid duplicates. */
  existingExperts: ExistingExpert[];
  /** Cross-module dependency data from import parsing. */
  moduleCoupling?: ModuleDependency[];
  /** Module clusters computed from dependency graph. */
  clusters?: ModuleCluster[];
}

export interface CrossReference {
  sourceDir: string;
  targetDir: string;
  referenceCount: number;
}

export interface ExistingExpert {
  slug: string;
  mountPath: string;
}

// ── AI Analysis (Stage 3 output) ───────────────────────────

export interface DiscoveryProposal {
  /** Proposed experts, ordered by confidence (highest first). */
  experts: ProposedExpert[];
  /** Brief rationale for the overall proposed structure. */
  rationale: string;
}

export interface ProposedExpert {
  /** URL-safe slug (lowercase, hyphens). */
  slug: string;
  /** Human-readable name. */
  name: string;
  /** Primary mount path relative to content root. */
  mountPath: string;
  /** Additional paths this expert should have visibility into. */
  additionalPaths?: string[];
  /** One-paragraph domain description for the claude.md stub. */
  description: string;
  /** Why this boundary was chosen. */
  reasoning: string;
  /** 0.0 to 1.0 — how confident the AI is in this proposal. */
  confidence: number;
}

// ── Interactive Review (Stage 4 output) ────────────────────

export type ReviewAction = 'accept' | 'edit' | 'skip';

export interface ReviewResult {
  /** Proposals the operator accepted (possibly edited). */
  accepted: ProposedExpert[];
  /** Proposals the operator skipped. */
  skipped: ProposedExpert[];
}

// ── Registration (Stage 5 output) ──────────────────────────

export interface RegisteredExpert {
  slug: string;
  mountPath: string;
  claudeMdPath?: string;
}

// ── Pipeline Result ────────────────────────────────────────

export interface DiscoveryResult {
  /** All proposals that passed confidence/count filtering. */
  proposed: ProposedExpert[];
  /** Proposals accepted during review. */
  accepted: ProposedExpert[];
  /** Proposals skipped during review. */
  skipped: ProposedExpert[];
  /** Successfully registered experts. */
  registered: RegisteredExpert[];
  /** Overall rationale from the AI analysis. */
  rationale: string;
  /** Diff result when running in --diff mode. */
  diffResult?: import('./diff.js').DiffResult;
}

// ── Stage Function Signatures ──────────────────────────────

/** Stage 1: Collect directory tree from the content root. */
export type CollectTreeFn = (rootPath: string, options?: TreeOptions) => string;

/** Stage 2: Enrich tree with database signals (FTS5, LSP). */
export type EnrichContextFn = (
  tree: string,
  db: LuxDatabase,
  options: DiscoveryOptions
) => DiscoveryContext;

/** Stage 3: Send context to AI for expert boundary proposals. */
export type AnalyzeFn = (
  context: DiscoveryContext,
  options: DiscoveryOptions
) => Promise<DiscoveryProposal>;

/** Stage 4: Present proposals for interactive human review. */
export type ReviewFn = (proposals: ProposedExpert[]) => Promise<ReviewResult>;

/** Stage 5: Register accepted experts in the database. */
export type RegisterFn = (
  accepted: ProposedExpert[],
  db: LuxDatabase,
  options: DiscoveryOptions
) => RegisteredExpert[] | Promise<RegisteredExpert[]>;

/** All stage implementations bundled for dependency injection. */
export interface PipelineStages {
  collectTree: CollectTreeFn;
  enrichContext: EnrichContextFn;
  analyze: AnalyzeFn;
  review: ReviewFn;
  register: RegisterFn;
}
