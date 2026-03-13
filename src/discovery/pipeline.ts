import type { LuxDatabase } from '../db/index.js';
import type { DiscoveryOptions, DiscoveryResult, PipelineStages, ProposedExpert } from './types.js';
import { diffProposals } from './diff.js';

// ── Constants ──────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_EXPERTS = 20;
const DEFAULT_MIN_CONFIDENCE = 0.5;

// ── Pipeline Orchestrator ──────────────────────────────────

/**
 * Run the expert discovery pipeline end-to-end.
 *
 * Orchestrates five stages in sequence:
 *   1. Collect directory tree from the content root
 *   2. Enrich the tree with FTS5/LSP signals (when available)
 *   3. Send context to AI for expert boundary proposals
 *   4. Present proposals for interactive human review
 *   5. Register accepted experts in the database
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
  const maxExperts = options.maxExperts ?? DEFAULT_MAX_EXPERTS;
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  // Stage 1: Collect directory tree
  const tree = stages.collectTree(options.rootPath);

  if (!tree.trim()) {
    return emptyResult('Directory tree is empty — nothing to analyze.');
  }

  // Stage 2: Enrich with database signals
  const context = stages.enrichContext(tree, db, options);

  // Stage 3: AI analysis
  const proposal = await stages.analyze(context, options);

  if (proposal.experts.length === 0) {
    return emptyResult(proposal.rationale || 'AI analysis returned no expert proposals.');
  }

  // Filter by confidence threshold and cap at max experts
  const candidates = filterCandidates(proposal.experts, minConfidence, maxExperts);

  if (candidates.length === 0) {
    return emptyResult(
      `All ${proposal.experts.length} proposals fell below the confidence threshold (${minConfidence}).`
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
        diffResult: diff,
      };
    }

    // Accept-all mode: skip interactive review, accept all actionable proposals
    let reviewed;
    if (options.acceptAll) {
      reviewed = { accepted: actionable, skipped: [] as ProposedExpert[] };
    } else {
      // Stage 4: Interactive review (only actionable proposals)
      reviewed = await stages.review(actionable);
    }

    if (reviewed.accepted.length === 0) {
      return {
        proposed: candidates,
        accepted: [],
        skipped: [...reviewed.skipped],
        registered: [],
        rationale: proposal.rationale,
        diffResult: diff,
      };
    }

    // Stage 5: Registration
    const registered = await stages.register(reviewed.accepted, db, options);

    return {
      proposed: candidates,
      accepted: reviewed.accepted,
      skipped: reviewed.skipped,
      registered,
      rationale: proposal.rationale,
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
    };
  }

  // Accept-all mode: skip interactive review, accept all candidates
  let reviewed;
  if (options.acceptAll) {
    reviewed = { accepted: candidates, skipped: [] as ProposedExpert[] };
  } else {
    // Stage 4: Interactive review
    reviewed = await stages.review(candidates);
  }

  if (reviewed.accepted.length === 0) {
    return {
      proposed: candidates,
      accepted: [],
      skipped: [...reviewed.skipped],
      registered: [],
      rationale: proposal.rationale,
    };
  }

  // Stage 5: Registration
  const registered = await stages.register(reviewed.accepted, db, options);

  return {
    proposed: candidates,
    accepted: reviewed.accepted,
    skipped: reviewed.skipped,
    registered,
    rationale: proposal.rationale,
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

/**
 * Resolve the effective model for AI analysis.
 */
export function resolveModel(options: DiscoveryOptions): string {
  return options.model ?? DEFAULT_MODEL;
}

function emptyResult(rationale: string): DiscoveryResult {
  return {
    proposed: [],
    accepted: [],
    skipped: [],
    registered: [],
    rationale,
  };
}
