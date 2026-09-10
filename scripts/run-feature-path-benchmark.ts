// Benchmark harness for tranche-one feature-path retrieval (T12).
//
// Usage:
//   tsx scripts/run-feature-path-benchmark.ts \
//     --db /tmp/lux-acme-core-feature-path.db \
//     --repo /path/to/acme-core/vcs \
//     --question "what handles POST /private-offers?" \
//     [--json]
//
// Prints the rendered text answer by default, or the full JSON payload with
// --json. Designed to be invoked once per benchmark question so the
// validation report can quote the answer surface verbatim.

import { LuxDatabase } from '../src/db/index.js';
import { resolveFeaturePathTarget } from '../src/scanner/associations/feature-path/resolve.js';
import { inferFeaturePathIntent } from '../src/scanner/associations/feature-path/intents.js';
import { assembleFeaturePathAnswer } from '../src/scanner/associations/feature-path/assemble.js';
import {
  renderFeaturePathAnswerJson,
  renderFeaturePathAnswerText,
} from '../src/scanner/associations/feature-path/render.js';

interface Args {
  db: string;
  repo: string;
  question: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case '--db':
        args.db = argv[++i];
        break;
      case '--repo':
        args.repo = argv[++i];
        break;
      case '--question':
        args.question = argv[++i];
        break;
      case '--json':
        args.json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (!args.db || !args.repo || !args.question) {
    throw new Error('Missing required arg(s). Need --db, --repo, --question.');
  }
  return args as Args;
}

const args = parseArgs(process.argv.slice(2));

const db = new LuxDatabase(args.db, false);
try {
  const intentResolution = inferFeaturePathIntent(args.question);
  const intent = intentResolution.intent ?? 'route-handler';
  const resolution = resolveFeaturePathTarget(db, args.question);
  const answer = assembleFeaturePathAnswer(db, {
    question: args.question,
    intent,
    resolution,
    repoRoot: args.repo,
  });
  process.stdout.write(
    args.json ? renderFeaturePathAnswerJson(answer) : renderFeaturePathAnswerText(answer)
  );
  process.stdout.write('\n');
} finally {
  db.close();
}
