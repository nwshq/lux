// src/cli/anchors.ts
import type { Command } from 'commander';
import { resolveRuntimePaths } from '../utils/runtime-paths.js';
import { openCliReadIndex, withReadTelemetry } from './read-index.js';
import { runAnchorSearch, anchorRefusalCoverage } from './anchor-search.js';
import { AnchorRefusalError } from '../scanner/anchors/anchor-refusal.js';
import { buildAnchorReport, buildAnchorRefusalReport } from './anchors-envelope.js';

interface AnchorsCommandOptions {
  limit: string;
  json?: boolean;
  granularity: string;
  includeTests?: boolean;
}

export function registerAnchorsCommand(program: Command): void {
  program
    .command('anchors')
    .description('Rank structural-node anchors (symbols) from a natural-language concept query')
    .argument('<query>', 'the concept to mint anchors from')
    .option('--limit <n>', 'max anchors to return', '10')
    .option(
      '--granularity <mode>',
      'result granularity: node (one anchor per symbol) or file (one representative anchor per file)',
      'node'
    )
    .option(
      '--include-tests',
      'include test files (excluded by default so the limit means N product-code anchors)'
    )
    .option('--json', 'emit the schemaVersion:1 anchors envelope')
    .action(async (query: string, options: AnchorsCommandOptions) => {
      // --corpus / --db are GLOBAL program options (index.ts:81-82), read via program.opts() like
      // every other command (getRuntimePaths / search.ts) — not per-command options here.
      const globalOpts = program.opts();
      const { corpusPath, dbPath } = resolveRuntimePaths({
        corpus: globalOpts.corpus as string | undefined,
        db: globalOpts.db as string | undefined,
      });
      // Validate --limit up front (a NaN/<1 limit is a usage error, exit 2 — never a fabricated answer).
      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) {
        console.error(`Error: --limit must be a positive integer (got '${options.limit}').`);
        process.exitCode = 2;
        return;
      }

      // Validate --granularity up front (an out-of-enum value is a usage error, exit 2).
      if (options.granularity !== 'node' && options.granularity !== 'file') {
        console.error(
          `Error: --granularity must be 'node' or 'file' (got '${options.granularity}').`
        );
        process.exitCode = 2;
        return;
      }
      const granularity = options.granularity;
      const includeTests = options.includeTests === true;

      const db = openCliReadIndex(dbPath, options.json ?? false);
      if (!db) return;
      try {
        const result = await runAnchorSearch(db, query, {
          limit,
          corpusPath,
          granularity,
          includeTests,
        });

        if (options.json) {
          console.log(
            JSON.stringify(
              withReadTelemetry(
                buildAnchorReport({
                  query,
                  limit,
                  granularity: result.granularity,
                  results: result.results,
                  lowConfidence: result.lowConfidence,
                  filters: result.filters,
                  coverage: result.coverage,
                })
              ),
              null,
              2
            )
          );
        } else {
          renderAnchorsText(query, result);
        }
      } catch (error) {
        if (error instanceof AnchorRefusalError) {
          // Accurate even on a non-overlay refusal (invalid-query) over a populated index; a genuine 0
          // for overlay-missing / anchor-texts-absent (anchor-search.ts anchorRefusalCoverage).
          const coverage = anchorRefusalCoverage(db);
          if (options.json) {
            console.log(
              JSON.stringify(
                withReadTelemetry(
                  buildAnchorRefusalReport({
                    query,
                    limit,
                    granularity,
                    // A refusal ran no ranking, so it dropped nothing; echo the requested test mode with a
                    // zero count so the envelope shape stays uniform with an answered query.
                    filters: {
                      tests: includeTests ? 'included' : 'excluded',
                      excludedTestFiles: 0,
                    },
                    coverage,
                    refusal: {
                      reason: error.reason,
                      expression: error.expression,
                      message: error.message,
                    },
                  })
                ),
                null,
                2
              )
            );
          } else {
            console.error(error.message);
            // Cross-surface hand-off (03 §The surface): point an operator at the other door.
            if (error.reason === 'overlay-missing' || error.reason === 'anchor-texts-absent') {
              console.error('  (documents/content? try `lux search`.)');
            }
          }
          process.exitCode = 1;
          return;
        }
        throw error; // genuinely unexpected — do not swallow
      } finally {
        db.close();
      }
    });
}

function renderAnchorsText(
  query: string,
  result: Awaited<ReturnType<typeof runAnchorSearch>>
): void {
  if (result.results.length === 0) {
    console.log(`No anchors found for: ${query}`);
    if (result.filters.tests === 'excluded' && result.filters.excludedTestFiles > 0) {
      // Don't let the default silently swallow the only matches; point at the restore flag.
      console.log(
        `  (${result.filters.excludedTestFiles} test file(s) were excluded — pass --include-tests to keep them.)`
      );
    }
    console.log('  (documents/content? try `lux search`.)'); // reciprocal hand-off
    return;
  }
  // Coverage line: the STABLE corpus fact ("is the corpus embedded?") is separate from whether THIS
  // query used the semantic half — so a lexical-answered query over an embedded corpus no longer reads
  // as "no embeddings yet" (issue #77 item #4). Fall back to the flat field if the split is absent.
  const cov = result.coverage;
  const index = cov.index;
  const covLine =
    !index || index.model === null
      ? 'corpus not embedded (lexical-only)'
      : cov.query?.semanticUsed
        ? `hybrid — ${index.embeddedNodes}/${index.totalNodes} nodes embedded under ${index.model}`
        : `lexical-only this query (${cov.query?.reason ?? 'n/a'}); corpus embedded ${index.embeddedNodes}/${index.totalNodes} under ${index.model}`;
  const filterNote =
    result.filters.tests === 'excluded' && result.filters.excludedTestFiles > 0
      ? `, ${result.filters.excludedTestFiles} test file(s) excluded`
      : '';
  console.log(
    `\nAnchors for "${query}" (${result.results.length}, ${result.granularity} granularity, ${covLine}${filterNote}):\n`
  );
  if (result.lowConfidence) {
    console.log(
      '  ⚠ low confidence — the top hit clears no confidence floor; treat as a suggestion,'
    );
    console.log('    not a seed to fire structural ops on unprompted.\n');
  }
  for (const r of result.results) {
    const fileNote = r.fileNodeCount !== undefined ? ` [${r.fileNodeCount} node(s) in file]` : '';
    console.log(
      `[${r.symbolKind}] ${r.qualifiedName ?? r.symbolName}  (${r.matchedVia}, score ${r.fusedScore.toFixed(4)})${fileNote}`
    );
    console.log(`  Path: ${r.filePath}`);
    console.log(`  → lux trace ${r.nodeId}`); // ready-to-paste next op (03 §The surface)
    console.log();
  }
}
