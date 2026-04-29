// CLI seam for tranche-one feature-path retrieval.
//
// Mirrors the surface of `lux overlay operational ask`: take a natural-language
// question, resolve it to a capability surface, infer the tranche-one intent,
// assemble the FeaturePathAnswer through the existing structural overlay, and
// emit the renderer's text or JSON output. This file is the operator-facing
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
import { resolveCorpusPath, resolveDbPath } from '../utils/runtime-paths.js';

export interface FeaturePathAskOptions {
  json?: boolean;
  /**
   * Override the question fragment used for resolution. When omitted, the full
   * question string is passed to the resolver — the resolver already strips
   * trailing `?` and lowercases internally.
   */
  target?: string;
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

  const resolverInput = options.target ?? question;
  const resolution = resolveFeaturePathTarget(db, resolverInput);

  // Tranche one stays narrow on route- and handler-centered intents (R11).
  // If the question doesn't match a locked pattern we still answer with
  // route-handler so the answer surface can refuse honestly through the
  // failures section rather than throwing.
  const intentResolution = inferFeaturePathIntent(question);
  const intent = intentResolution.intent ?? 'route-handler';

  const answer = assembleFeaturePathAnswer(db, {
    question,
    intent,
    resolution,
    repoRoot: corpusPath,
  });

  if (options.json) {
    console.log(renderFeaturePathAnswerJson(answer));
  } else {
    console.log(renderFeaturePathAnswerText(answer));
  }

  db.close();
  if (resolution.status !== 'resolved') process.exit(1);
}
