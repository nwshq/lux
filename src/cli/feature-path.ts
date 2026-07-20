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
import {
  renderFeaturePathAnswerJson,
  renderFeaturePathAnswerText,
} from '../scanner/associations/feature-path/render.js';
import { resolveFeaturePathTarget } from '../scanner/associations/feature-path/resolve.js';
import { emitUsageEvent, createInvocationId } from '../db/observability/usage-event.js';
import { resolveCorpusPath, resolveDbPath } from '../utils/runtime-paths.js';
import type { FeaturePathAnswer } from '../scanner/associations/feature-path/contract.js';

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

  return {
    answer,
    rendered: options.json
      ? renderFeaturePathAnswerJson(answer)
      : renderFeaturePathAnswerText(answer),
    exitCode: resolution.status === 'resolved' ? 0 : 1,
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
  const db = new LuxDatabase(
    resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
  );
  const invocationId = createInvocationId();
  const startedAt = Date.now();

  const result = executeFeaturePathAsk(db, question, { ...options, corpusPath });

  console.log(result.rendered);
  emitUsageEvent(db, {
    source: 'cli',
    surface: 'feature-path',
    action: 'ask',
    invocationId,
    commandOutcome: result.exitCode === 0 ? 'success' : 'error',
    retrievalOutcome:
      result.answer.resolution.status === 'resolved'
        ? 'answered'
        : result.answer.resolution.status === 'ambiguous'
          ? 'ambiguous'
          : 'unresolved',
    durationMs: Date.now() - startedAt,
    exitCode: result.exitCode,
    corpusPath,
    queryText: question || options.target,
    normalizedIntent: result.answer.intent,
    retrieval: {
      promoted: false,
      resolvedTargetType: result.answer.resolution.status,
      directEvidenceCount: result.answer.directEvidence.length,
      contextualEvidenceCount: result.answer.context.length,
    },
  });

  db.close();
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
