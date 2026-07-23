// src/cli/anchors.ts
import type { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';
import { resolveRuntimePaths } from '../utils/runtime-paths.js';
import { emitUsageEvent, createInvocationId } from '../db/observability/usage-event.js';
import { runAnchorSearch, anchorRefusalCoverage } from './anchor-search.js';
import { AnchorRefusalError } from '../scanner/anchors/anchor-refusal.js';
import { buildAnchorReport, buildAnchorRefusalReport } from './anchors-envelope.js';

interface AnchorsCommandOptions {
  limit: string;
  json?: boolean;
}

export function registerAnchorsCommand(program: Command): void {
  program
    .command('anchors')
    .description('Rank structural-node anchors (symbols) from a natural-language concept query')
    .argument('<query>', 'the concept to mint anchors from')
    .option('--limit <n>', 'max anchors to return', '10')
    .option('--json', 'emit the schemaVersion:1 anchors envelope')
    .action(async (query: string, options: AnchorsCommandOptions) => {
      // --corpus / --db are GLOBAL program options (index.ts:81-82), read via program.opts() like
      // every other command (getRuntimePaths / search.ts) — not per-command options here.
      const globalOpts = program.opts();
      const { corpusPath, dbPath } = resolveRuntimePaths({
        corpus: globalOpts.corpus as string | undefined,
        db: globalOpts.db as string | undefined,
      });
      const invocationId = createInvocationId();
      const startedAt = Date.now();

      // Validate --limit up front (a NaN/<1 limit is a usage error, exit 2 — never a fabricated answer).
      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) {
        console.error(`Error: --limit must be a positive integer (got '${options.limit}').`);
        process.exitCode = 2;
        return;
      }

      const db = new LuxDatabase(dbPath);
      try {
        const result = await runAnchorSearch(db, query, { limit });

        if (options.json) {
          console.log(
            JSON.stringify(
              buildAnchorReport({
                query,
                limit,
                results: result.results,
                lowConfidence: result.lowConfidence,
                coverage: result.coverage,
              }),
              null,
              2
            )
          );
        } else {
          renderAnchorsText(query, result);
        }

        emitUsageEvent(db, {
          source: 'cli',
          surface: 'anchors',
          action: 'query',
          invocationId,
          commandOutcome: 'success',
          retrievalOutcome: result.results.length > 0 ? 'answered' : 'unresolved',
          durationMs: Date.now() - startedAt,
          exitCode: 0,
          corpusPath,
          queryText: query,
          attributes: {
            limit,
            resultsCount: result.results.length,
            lowConfidence: result.lowConfidence,
            embeddedNodes: result.coverage.embeddedNodes,
            anchorViableNodes: result.coverage.anchorViableNodes,
            model: result.coverage.model,
          },
        });
      } catch (error) {
        if (error instanceof AnchorRefusalError) {
          // Accurate even on a non-overlay refusal (invalid-query) over a populated index; a genuine 0
          // for overlay-missing / anchor-texts-absent (anchor-search.ts anchorRefusalCoverage).
          const coverage = anchorRefusalCoverage(db);
          if (options.json) {
            console.log(
              JSON.stringify(
                buildAnchorRefusalReport({
                  query,
                  limit,
                  coverage,
                  refusal: {
                    reason: error.reason,
                    expression: error.expression,
                    message: error.message,
                  },
                }),
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
          emitUsageEvent(db, {
            source: 'cli',
            surface: 'anchors',
            action: 'query',
            invocationId,
            commandOutcome: 'error',
            retrievalOutcome: 'refused',
            durationMs: Date.now() - startedAt,
            exitCode: 1,
            corpusPath,
            queryText: query,
            attributes: { limit },
            error: { code: error.reason },
          });
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
    console.log('  (documents/content? try `lux search`.)'); // reciprocal hand-off
    return;
  }
  const cov = result.coverage;
  const covLine =
    cov.model === null
      ? 'lexical-only (no embeddings yet)'
      : `hybrid — ${cov.embeddedNodes}/${cov.anchorViableNodes} nodes embedded under ${cov.model}`;
  console.log(`\nAnchors for "${query}" (${result.results.length}, ${covLine}):\n`);
  if (result.lowConfidence) {
    console.log(
      '  ⚠ low confidence — the top hit clears no confidence floor; treat as a suggestion,'
    );
    console.log('    not a seed to fire structural ops on unprompted.\n');
  }
  for (const r of result.results) {
    console.log(
      `[${r.symbolKind}] ${r.qualifiedName ?? r.symbolName}  (${r.matchedVia}, score ${r.fusedScore.toFixed(4)})`
    );
    console.log(`  Path: ${r.filePath}`);
    console.log(`  → lux trace ${r.nodeId}`); // ready-to-paste next op (03 §The surface)
    console.log();
  }
}
