export { runDiscoveryPipeline, filterCandidates, resolveModel } from './pipeline.js';
export { createDefaultStages } from './defaults.js';
export {
  enrichContext,
  aggregateFileCountsByDirectory,
  extractSymbolSummaries,
  extractCrossReferences,
} from './enrich.js';
export {
  collectTree,
  DISCOVERY_TREE_DEPTH,
  DISCOVERY_TREE_ENTRIES,
  IGNORE_DIRS,
} from './collect-tree.js';
export { analyze, buildAnalysisPrompt, parseProposalResponse } from './analyze.js';
export {
  review,
  formatProposalTable as formatReviewTable,
  formatProposalDetail as formatReviewDetail,
  editProposal,
} from './review.js';
export type { ReviewIO } from './review.js';
export { register, generateClaudeMdStub, detectClaudeMd } from './register.js';
export type {
  DiscoveryOptions,
  DiscoveryResult,
  DiscoveryContext,
  DiscoveryProposal,
  ProposedExpert,
  ReviewResult,
  ReviewAction,
  RegisteredExpert,
  TreeOptions,
  CrossReference,
  ExistingExpert,
  CollectTreeFn,
  EnrichContextFn,
  AnalyzeFn,
  ReviewFn,
  RegisterFn,
  PipelineStages,
} from './types.js';

// Diff logic (Phase 4: Rediscovery)
export { diffProposals, detectStaleExperts, checkExpertStaleness } from './diff.js';
export type {
  DiffResult,
  DiffOptions,
  ClassifiedProposal,
  StaleExpert,
  ProposalStatus,
} from './diff.js';
