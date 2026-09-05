import type { Command } from 'commander';
import { openIndex } from '../db/open-policy.js';
import { openCliReadIndex, withReadTelemetry } from './read-index.js';
import { buildUsageReport, parseSince } from '../db/observability/usage-report.js';
import { emitUsageEvent } from '../db/observability/usage-event.js';
import type {
  UsageCommandOutcome,
  UsageEventSurface,
  UsageRetrievalOutcome,
  UsageTrustState,
} from '../db/observability/usage-event.js';
import { resolveCorpusPath, resolveDbPath } from '../utils/runtime-paths.js';

interface UsageReportOptions {
  since?: string;
  surface?: UsageEventSurface;
  commandOutcome?: UsageCommandOutcome;
  retrievalOutcome?: UsageRetrievalOutcome;
  trustState?: UsageTrustState;
  json?: boolean;
}

interface HookEventOptions {
  outcome: 'success' | 'error' | 'skipped';
  reason?: string;
  changedCount?: string;
  exitCode?: string;
  timeoutSeconds?: string;
  message?: string;
  corpus?: string;
  db?: string;
}

export function addUsageCommands(program: Command): void {
  const usage = program
    .command('usage')
    .description('Inspect local Lux usage observability events');

  usage
    .command('hook-event')
    .description('Internal: record a Lux-managed hook usage event')
    .option('--outcome <outcome>', 'Hook outcome: success|error|skipped')
    .option('--reason <reason>', 'Hook outcome reason')
    .option('--changed-count <count>', 'Changed indexable file count')
    .option('--exit-code <code>', 'Hook/sync exit code')
    .option('--timeout-seconds <seconds>', 'Hook timeout setting')
    .option('--message <message>', 'Short diagnostic message')
    .option('--corpus <path>', 'Corpus path for the hook repository')
    .option('--db <path>', 'Database path override')
    .action((options: HookEventOptions) => {
      const outcome = parseHookOutcome(options.outcome);
      const opts = program.opts();
      const corpusPath = resolveCorpusPath({
        corpus: options.corpus || (opts.corpus as string | undefined),
      });
      const dbPath = resolveDbPath({
        corpus: corpusPath,
        db: options.db || (opts.db as string | undefined),
      });
      const current = openIndex(dbPath, 'write-existing');
      const opened =
        !current.ok && current.refusal === 'index-absent'
          ? openIndex(dbPath, 'create-or-migrate')
          : current;
      if (!opened.ok) {
        console.error(`Error: ${opened.message}`);
        process.exitCode = 1;
        return;
      }
      const db = opened.db;

      try {
        const changedCount = parseOptionalInteger(options.changedCount, '--changed-count');
        const exitCode = parseOptionalInteger(options.exitCode, '--exit-code');
        const timeoutSeconds = parseOptionalInteger(options.timeoutSeconds, '--timeout-seconds');
        const commandOutcome = outcome === 'success' || outcome === 'skipped' ? 'success' : 'error';
        emitUsageEvent(db, {
          source: 'hook',
          surface: 'hook',
          action: outcome,
          commandOutcome,
          retrievalOutcome: 'not_applicable',
          exitCode: exitCode ?? (commandOutcome === 'success' ? 0 : 1),
          corpusPath,
          attributes: {
            reason: options.reason,
            changedCount,
            timeoutSeconds,
            message: options.message,
          },
        });
      } finally {
        db.close();
      }
    });

  usage
    .command('report')
    .description('Summarize local usage events from the repo-local SQLite database')
    .option('--since <window>', 'ISO timestamp or relative window such as 7d, 24h, or 2w')
    .option('--surface <surface>', 'Filter by surface')
    .option('--command-outcome <outcome>', 'Filter by command outcome: success|error')
    .option(
      '--retrieval-outcome <outcome>',
      'Filter by retrieval outcome: answered|refused|ambiguous|unresolved|fallback|not_applicable'
    )
    .option('--trust-state <state>', 'Filter by trust state')
    .option('--json', 'Emit machine-readable JSON')
    .action((options: UsageReportOptions) => {
      const opts = program.opts();
      const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
      const db = openCliReadIndex(
        resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined }),
        options.json ?? false
      );
      if (!db) return;

      try {
        const report = buildUsageReport(db.getRecentEvents(10000), {
          since: parseSince(options.since),
          surface: options.surface,
          commandOutcome: options.commandOutcome,
          retrievalOutcome: options.retrievalOutcome,
          trustState: options.trustState,
        });

        if (options.json) {
          console.log(JSON.stringify(withReadTelemetry(report), null, 2));
          return;
        }

        console.log('\nLux Usage Report\n');
        if (report.since) console.log(`  Since: ${report.since}`);
        console.log(`  Until: ${report.until}`);
        console.log(`  Invocations: ${report.totals.invocations}`);
        console.log(`  Events: ${report.totals.events}`);

        printRecord(
          '\nSurfaces:',
          Object.fromEntries(
            Object.entries(report.surfaces).map(([surface, bucket]) => [surface, bucket.events])
          )
        );
        printRecord('\nCommand outcomes:', report.commandOutcomes);
        printRecord('\nRetrieval outcomes:', report.retrievalOutcomes);
        printRecord('\nTrust states:', report.trustStates);

        if (report.fallbacks.length > 0) {
          console.log('\nFallbacks:');
          for (const fallback of report.fallbacks) {
            console.log(`  ${fallback.from} -> ${fallback.to}: ${fallback.count}`);
          }
        }

        if (report.benchmarkCandidates.length > 0) {
          console.log('\nBenchmark candidates:');
          for (const candidate of report.benchmarkCandidates) {
            console.log(
              `  ${candidate.surface} ${candidate.reason}: ${candidate.count} (${candidate.intentHash})`
            );
          }
        }
        console.log();
      } finally {
        db.close();
      }
    });
}

function printRecord(label: string, record: Record<string, number>): void {
  if (Object.keys(record).length === 0) return;
  console.log(label);
  for (const [key, count] of Object.entries(record)) {
    console.log(`  ${key}: ${count}`);
  }
}

function parseHookOutcome(value: string | undefined): HookEventOptions['outcome'] {
  if (value === 'success' || value === 'error' || value === 'skipped') return value;
  throw new Error('Error: --outcome must be one of success, error, skipped.');
}

function parseOptionalInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Error: ${label} must be a non-negative integer.`);
  }
  return parsed;
}
