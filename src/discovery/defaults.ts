import { collectTree } from './collect-tree.js';
import { enrichContext } from './enrich.js';
import { analyze } from './analyze.js';
import { deriveCandidateRegions } from './derive-candidate-regions.js';
import { review } from './review.js';
import { register } from './register.js';
import type { PipelineStages } from './types.js';

/**
 * Create default stage implementations for expert discovery.
 *
 * - collectTree: Discovery-specific tree collector with configurable
 *   depth (default 8) and entry (default 500) limits.
 * - enrichContext: Queries FTS5 file counts, LSP symbol summaries,
 *   and cross-references from the database. Degrades gracefully when
 *   no indexed data exists.
 * - deriveCandidateRegions: Computes structurally salient candidate expert regions.
 * - analyze: Spawns the configured analysis backend with discovery context for expert proposals.
 * - review: Interactive terminal review with accept/edit/skip/quit actions.
 * - register: Inserts experts into DB and generates expert instruction stubs when absent.
 */
export function createDefaultStages(): PipelineStages {
  return {
    collectTree,
    enrichContext,
    deriveCandidateRegions,
    analyze,
    review,
    register,
  };
}
