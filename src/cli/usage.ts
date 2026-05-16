import type { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';
import { buildUsageReport, parseSince } from '../db/observability/usage-report.js';
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

export function addUsageCommands(program: Command): void {
  const usage = program
    .command('usage')
    .description('Inspect local Lux usage observability events');

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
      const db = new LuxDatabase(
        resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
      );

      try {
        const report = buildUsageReport(db.getRecentEvents(10000), {
          since: parseSince(options.since),
          surface: options.surface,
          commandOutcome: options.commandOutcome,
          retrievalOutcome: options.retrievalOutcome,
          trustState: options.trustState,
        });

        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
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
