import type { LuxDatabase } from '../../../src/db/index.js';
import type { ModuleDependency } from '../../../src/db/types.js';

type AiThinking = string;
interface ModuleCluster {
  modules: string[];
}
interface OverlayNeighborhood {
  [key: string]: unknown;
}
interface ExpertStructuralSignature {
  [key: string]: unknown;
}
type OverlayTrustLevel = string;

// ── Discovery Options ──────────────────────────────────────

export interface DiscoveryOptions {
  /** Absolute path to the content root directory. */
  rootPath: string;
  /** AI model for analysis (default: gpt-5.4). */
  model?: string;
  /** Optional provider for Pi-backed analysis calls. */
  provider?: string;
  /** Analysis backend for discovery calls. */
  backend?: 'claude' | 'pi';
  /** Optional separate backend for synthesis. */
  synthesisBackend?: 'claude' | 'pi';
  /** Optional separate provider for synthesis. */
  synthesisProvider?: string;
  /** Optional separate model for synthesis. */
  synthesisModel?: string;
  /** Optional Pi thinking level for Pi-backed calls. */
  thinking?: AiThinking;
  /** Optional timeout for each analysis subprocess in milliseconds. */
  analysisTimeoutMs?: number;
  /** Show proposals without registering. */
  dryRun?: boolean;
  /** Output proposals as JSON and skip interactive review. */
  json?: boolean;
  /** Maximum number of experts to propose. Treated as a fixed top-N slice unless countSelectionMode is set. */
  maxExperts?: number;
  /** Whether count limiting represents a benchmark slice or inventory-oriented safety cap. */
  countSelectionMode?: ExpertCountSelectionMode;
  /** Minimum confidence threshold 0.0–1.0 (default: 0.5). */
  minConfidence?: number;
  /** Accept all proposals without interactive review. */
  acceptAll?: boolean;
  /** Only show proposals that differ from current experts. */
  diff?: boolean;
}

export type ExpertCountSelectionMode = 'top-n-slice' | 'quality-gated-inventory';

export type ExpertCountStopReason = 'none' | 'confidence-threshold' | 'top-n-slice' | 'safety-cap';

export interface ExpertCountPolicy {
  selectionMode: ExpertCountSelectionMode;
  minConfidence: number;
  proposalCountBeforeFilter: number;
  eligibleCountAfterConfidence: number;
  acceptedCountAfterCountLimit: number;
  stoppedBecause: ExpertCountStopReason;
  /** Fixed count used when selectionMode is top-n-slice. */
  maxExperts?: number;
  /** Safety cap used when selectionMode is quality-gated-inventory. */
  safetyCap?: number;
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
  /** Current overlay trust level. Present when overlay data exists. */
  overlayTrustState?: OverlayTrustLevel;
  /** Overlay-native structural neighborhoods. Present when trust is sufficient. */
  overlayNeighborhoods?: OverlayNeighborhood[];
  /** Structurally ranked candidate expert regions prepared for AI synthesis. */
  candidateRegions?: CandidateRegion[];
}

export interface CrossReference {
  sourceDir: string;
  targetDir: string;
  referenceCount: number;
}

export interface ExistingExpert {
  slug: string;
  mountPath: string;
  /** Structural signature when available (structurally enriched experts only). */
  structuralSignature?: ExpertStructuralSignature;
  /** How the expert boundary was originally determined. */
  boundaryBasis?: 'directory-led' | 'overlay-led' | 'dependency-led' | 'reference-led' | 'hybrid';
}

export interface CandidateRegion {
  id: string;
  label: string;
  anchorPaths: string[];
  dominantDirectories: string[];
  supportingPaths?: string[];
  basis: 'overlay-led' | 'dependency-led' | 'reference-led' | 'hybrid';
  salienceScore: number;
  cohesionScore?: number;
  externalCouplingScore?: number;
  trustWeight?: number;
  evidence: string[];
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
  /** One-paragraph domain description for the expert instruction stub. */
  description: string;
  /** Why this boundary was chosen. */
  reasoning: string;
  /** 0.0 to 1.0 — how confident the AI is in this proposal. */
  confidence: number;
  /** Whether the boundary is driven by directory layout, overlay structure, or both. */
  boundaryBasis?: 'directory-led' | 'overlay-led' | 'dependency-led' | 'reference-led' | 'hybrid';
  /** Structural rationale explaining overlay-derived boundary evidence. */
  structuralRationale?: string;
  /** Structural signature for persistence (populated from overlay analysis). */
  structuralSignature?: ExpertStructuralSignature;
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
  /** Count-selection metadata for distinguishing top-N slices from inventory discovery. */
  countPolicy: ExpertCountPolicy;
  /** Diff result when running in --diff mode. */
  diffResult?: unknown;
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

/** Stage 3: Derive candidate expert regions from structural signals. */
export type DeriveCandidateRegionsFn = (
  context: DiscoveryContext,
  options: DiscoveryOptions
) => DiscoveryContext;

/** Stage 4: Send context to AI for expert boundary proposals. */
export type AnalyzeFn = (
  context: DiscoveryContext,
  options: DiscoveryOptions
) => DiscoveryProposal | Promise<DiscoveryProposal>;

/** Stage 5: Present proposals for interactive human review. */
export type ReviewFn = (proposals: ProposedExpert[]) => Promise<ReviewResult>;

/** Stage 6: Register accepted experts in the database. */
export type RegisterFn = (
  accepted: ProposedExpert[],
  db: LuxDatabase,
  options: DiscoveryOptions
) => RegisteredExpert[] | Promise<RegisteredExpert[]>;

/** All stage implementations bundled for dependency injection. */
export interface PipelineStages {
  collectTree: CollectTreeFn;
  enrichContext: EnrichContextFn;
  deriveCandidateRegions: DeriveCandidateRegionsFn;
  analyze: AnalyzeFn;
  review: ReviewFn;
  register: RegisterFn;
}
