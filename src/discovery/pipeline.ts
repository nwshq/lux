import type { LuxDatabase } from '../db/index.js';
import type {
  DiscoveryOptions,
  DiscoveryResult,
  ExpertCountPolicy,
  PipelineStages,
  ProposedExpert,
} from './types.js';
import { diffProposals } from './diff.js';

// ── Constants ──────────────────────────────────────────────

const DEFAULT_MODEL = 'gpt-5.4';
const DEFAULT_MAX_EXPERTS = 20;
const DEFAULT_INVENTORY_SAFETY_CAP = 16;
const DEFAULT_MIN_CONFIDENCE = 0.5;

// ── Pipeline Orchestrator ──────────────────────────────────

/**
 * Run the expert discovery pipeline end-to-end.
 *
 * Orchestrates five stages in sequence:
 *   1. Collect directory tree from the content root
 *   2. Enrich the tree with FTS5/LSP signals (when available)
 *   3. Derive structurally salient candidate expert regions
 *   4. Send context to AI for expert boundary proposals
 *   5. Present proposals for interactive human review
 *   6. Register accepted experts in the database
 *
 * Stages are injected via `stages` to support testing and
 * incremental implementation. Each stage is a pure function
 * (or async function) with a well-defined signature.
 */
export async function runDiscoveryPipeline(
  db: LuxDatabase,
  options: DiscoveryOptions,
  stages: PipelineStages
): Promise<DiscoveryResult> {
  const countConfig = resolveCountConfig(options);
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  // Stage 1: Collect directory tree
  const tree = stages.collectTree(options.rootPath);

  if (!tree.trim()) {
    return emptyResult('Directory tree is empty — nothing to analyze.', emptyCountPolicy(options));
  }

  // Stage 2: Enrich with database signals
  const enrichedContext = stages.enrichContext(tree, db, options);

  // Stage 3: Derive structurally salient candidate regions
  const context = stages.deriveCandidateRegions(enrichedContext, options);

  // Stage 4: AI analysis
  const proposal = await stages.analyze(context, options);

  if (proposal.experts.length === 0) {
    return emptyResult(
      proposal.rationale || 'AI analysis returned no expert proposals.',
      emptyCountPolicy(options)
    );
  }

  // Filter by confidence threshold and apply the configured count policy.
  const { candidates, countPolicy } = selectCandidates(
    proposal.experts,
    minConfidence,
    countConfig
  );

  if (candidates.length === 0) {
    return emptyResult(
      `All ${proposal.experts.length} proposals fell below the confidence threshold (${minConfidence}).`,
      countPolicy
    );
  }

  // Diff filtering: compare proposals against registered experts
  // When --diff is enabled, only new and updated proposals proceed to review.
  if (options.diff) {
    const experts = db.getAllExperts();
    const diff = diffProposals(candidates, experts, {
      contentRoot: options.rootPath,
    });

    const actionable = [
      ...diff.newProposals.map((c) => c.proposal),
      ...diff.updatedProposals.map((c) => c.proposal),
    ];

    // Dry-run and JSON modes skip review and registration
    if (options.dryRun || options.json) {
      return {
        proposed: candidates,
        accepted: [],
        skipped: candidates,
        registered: [],
        rationale: proposal.rationale,
        countPolicy,
        diffResult: diff,
      };
    }

    if (actionable.length === 0) {
      return {
        proposed: candidates,
        accepted: [],
        skipped: [],
        registered: [],
        rationale: proposal.rationale,
        countPolicy,
        diffResult: diff,
      };
    }

    // Accept-all mode: skip interactive review, accept all actionable proposals
    let reviewed;
    if (options.acceptAll) {
      reviewed = { accepted: actionable, skipped: [] as ProposedExpert[] };
    } else {
      // Stage 5: Interactive review (only actionable proposals)
      reviewed = await stages.review(actionable);
    }

    if (reviewed.accepted.length === 0) {
      return {
        proposed: candidates,
        accepted: [],
        skipped: [...reviewed.skipped],
        registered: [],
        rationale: proposal.rationale,
        countPolicy,
        diffResult: diff,
      };
    }

    // Stage 6: Registration
    const registered = await stages.register(reviewed.accepted, db, options);

    return {
      proposed: candidates,
      accepted: reviewed.accepted,
      skipped: reviewed.skipped,
      registered,
      rationale: proposal.rationale,
      countPolicy,
      diffResult: diff,
    };
  }

  // Dry-run and JSON modes skip review and registration
  if (options.dryRun || options.json) {
    return {
      proposed: candidates,
      accepted: [],
      skipped: candidates,
      registered: [],
      rationale: proposal.rationale,
      countPolicy,
    };
  }

  // Accept-all mode: skip interactive review, accept all candidates
  let reviewed;
  if (options.acceptAll) {
    reviewed = { accepted: candidates, skipped: [] as ProposedExpert[] };
  } else {
    // Stage 5: Interactive review
    reviewed = await stages.review(candidates);
  }

  if (reviewed.accepted.length === 0) {
    return {
      proposed: candidates,
      accepted: [],
      skipped: [...reviewed.skipped],
      registered: [],
      rationale: proposal.rationale,
      countPolicy,
    };
  }

  // Stage 6: Registration
  const registered = await stages.register(reviewed.accepted, db, options);

  return {
    proposed: candidates,
    accepted: reviewed.accepted,
    skipped: reviewed.skipped,
    registered,
    rationale: proposal.rationale,
    countPolicy,
  };
}

// ── Helpers ────────────────────────────────────────────────

/**
 * Filter proposals by confidence threshold and cap count.
 * Proposals are assumed to already be sorted by confidence (highest first)
 * from the AI analysis stage.
 */
export function filterCandidates(
  experts: ProposedExpert[],
  minConfidence: number,
  maxExperts: number
): ProposedExpert[] {
  return experts.filter((e) => e.confidence >= minConfidence).slice(0, maxExperts);
}

interface CountConfig {
  selectionMode: ExpertCountPolicy['selectionMode'];
  limit: number;
}

function resolveCountConfig(options: DiscoveryOptions): CountConfig {
  const selectionMode = options.countSelectionMode ?? 'top-n-slice';
  const defaultLimit =
    selectionMode === 'quality-gated-inventory'
      ? DEFAULT_INVENTORY_SAFETY_CAP
      : DEFAULT_MAX_EXPERTS;
  return {
    selectionMode,
    limit: options.maxExperts ?? defaultLimit,
  };
}

function selectCandidates(
  experts: ProposedExpert[],
  minConfidence: number,
  countConfig: CountConfig
): { candidates: ProposedExpert[]; countPolicy: ExpertCountPolicy } {
  const eligible = experts.filter((e) => e.confidence >= minConfidence);
  const candidates = eligible.slice(0, countConfig.limit);
  const capped = eligible.length > candidates.length;
  const countPolicy: ExpertCountPolicy = {
    selectionMode: countConfig.selectionMode,
    minConfidence,
    proposalCountBeforeFilter: experts.length,
    eligibleCountAfterConfidence: eligible.length,
    acceptedCountAfterCountLimit: candidates.length,
    stoppedBecause:
      eligible.length === 0
        ? 'confidence-threshold'
        : capped
          ? countConfig.selectionMode === 'quality-gated-inventory'
            ? 'safety-cap'
            : 'top-n-slice'
          : 'none',
    ...(countConfig.selectionMode === 'quality-gated-inventory'
      ? { safetyCap: countConfig.limit }
      : { maxExperts: countConfig.limit }),
  };
  return { candidates, countPolicy };
}

function emptyCountPolicy(options: DiscoveryOptions): ExpertCountPolicy {
  const countConfig = resolveCountConfig(options);
  return {
    selectionMode: countConfig.selectionMode,
    minConfidence: options.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    proposalCountBeforeFilter: 0,
    eligibleCountAfterConfidence: 0,
    acceptedCountAfterCountLimit: 0,
    stoppedBecause: 'none',
    ...(countConfig.selectionMode === 'quality-gated-inventory'
      ? { safetyCap: countConfig.limit }
      : { maxExperts: countConfig.limit }),
  };
}

/**
 * Resolve the effective model for AI analysis.
 */
export function resolveModel(options: DiscoveryOptions): string {
  return options.model ?? DEFAULT_MODEL;
}

function emptyResult(rationale: string, countPolicy: ExpertCountPolicy): DiscoveryResult {
  return {
    proposed: [],
    accepted: [],
    skipped: [],
    registered: [],
    rationale,
    countPolicy,
  };
}
