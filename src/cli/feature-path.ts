// CLI seam for tranche-one feature-path retrieval.
//
// Mirrors the surface of `lux overlay operational ask`: take a natural-language
// question, resolve it to a capability surface, infer the tranche-one intent,
// assemble the FeaturePathAnswer retrieval view through the existing structural
// overlay, and emit the renderer's text or JSON output. This file is the
// operator-facing
// wiring; all retrieval logic lives in src/scanner/associations/feature-path.

import type { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';
import { assembleFeaturePathAnswer } from '../scanner/associations/feature-path/assemble.js';
import { inferFeaturePathIntent } from '../scanner/associations/feature-path/intents.js';
import { renderFeaturePathAnswerText } from '../scanner/associations/feature-path/render.js';
import { resolveFeaturePathTarget } from '../scanner/associations/feature-path/resolve.js';
import { resolveCorpusPath, resolveDbPath } from '../utils/runtime-paths.js';
import { openCliReadIndex, withReadTelemetry } from './read-index.js';
import type { FeaturePathAnswer } from '../scanner/associations/feature-path/contract.js';
import {
  summarizeStaleSupport,
  staleSupportWarning,
  type StaleSupportSummary,
} from '../scanner/freshness.js';

export interface FeaturePathAskOptions {
  json?: boolean;
  /**
   * Override the question fragment used for resolution. When omitted, the full
   * question string is passed to the resolver — the resolver already strips
   * trailing `?` and lowercases internally.
   */
  target?: string;
}

export interface FeaturePathAskExecutionResult {
  answer: FeaturePathAnswer;
  rendered: string;
  exitCode: 0 | 1;
  /** Read-only stale-support annotation over the resolved surface's structural edges (SC-4). */
  staleSupport: StaleSupportSummary;
}

function executeFeaturePathAsk(
  db: LuxDatabase,
  question: string,
  options: FeaturePathAskOptions & { corpusPath: string }
): FeaturePathAskExecutionResult {
  const resolverInput = options.target ?? question;
  const resolution = resolveFeaturePathTarget(db, resolverInput);

  // Tranche one stays narrow on route- and handler-centered intents (R11).
  // If the direct overlay seam is invoked with a question that doesn't match a
  // locked pattern, answer with route-handler so the surface can refuse honestly
  // through the failures section rather than throwing.
  const intentResolution = inferFeaturePathIntent(question);
  const intent = intentResolution.intent ?? 'route-handler';

  const answer = assembleFeaturePathAnswer(db, {
    question,
    intent,
    resolution,
    repoRoot: options.corpusPath,
  });

  // Stale-aware annotation (Decision 4 / SC-4): read-only — summarize how many of the resolved
  // surface's supporting structural edges the maintained marks flag `stale`. The `handled_by`
  // provider edge lives on the surface node (source_node_id === surface id), so the surface's
  // incident edges are exactly the structural claims backing this answer. Never mutates freshness.
  const staleSupport = summarizeStaleSupport(
    answer.target ? db.getStructuralEdgesForNode(answer.target.id) : []
  );

  return {
    answer,
    rendered: options.json
      ? JSON.stringify(withReadTelemetry({ ...answer, staleSupport }), null, 2)
      : renderFeaturePathAnswerText(answer),
    exitCode: resolution.status === 'resolved' ? 0 : 1,
    staleSupport,
  };
}

export function runFeaturePathAsk(
  program: Command,
  questionParts: string[],
  options: FeaturePathAskOptions
): void {
  const question = questionParts.join(' ').trim();
  if (!question && !options.target) {
    console.error('Error: ask requires a question or --target.');
    process.exit(1);
  }

  const opts = program.opts();
  const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
  const dbPath = resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined });
  const db = openCliReadIndex(dbPath, options.json ?? false);
  if (!db) return;

  try {
    const result = executeFeaturePathAsk(db, question, { ...options, corpusPath });

    console.log(result.rendered);
    if (!options.json) {
      const staleWarning = staleSupportWarning(result.staleSupport);
      if (staleWarning) console.warn('Warning: ' + staleWarning);
    }
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  } finally {
    db.close();
  }
}
