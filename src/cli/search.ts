import { Command } from 'commander';
import { LuxDatabase, SearchRefusalError, coerceSearchLimit } from '../db/index.js';
import type { RankedSearchResult } from '../db/types.js';
import {
  buildSearchReport,
  buildSearchRefusalReport,
  type SearchReportV1,
} from './search-envelope.js';
import { detectModuleBoundaries, resolveModule } from '../scanner/imports/module-boundary.js';
import { emitUsageEvent, createInvocationId } from '../db/observability/usage-event.js';
import { resolveCorpusPath, resolveDbPath } from '../utils/runtime-paths.js';
import {
  resolveSiblings,
  buildFederationBlock,
  siblingFaultRefusal,
  type SiblingResolution,
} from '../scanner/siblings.js';
import { runFederatedSearch } from '../scanner/search-federation.js';

export function addSearchCommand(program: Command) {
  program
    .command('search <query>')
    .description('Search all indexed documents using full-text search')
    .option('--type <type>', 'Filter by entity type (all|knowledge)', 'all')
    .option('--limit <n>', 'Limit results', '20')
    .option('--content', 'Search only file content (not metadata)')
    .option('--snippets', 'Include a query-centered snippet per result (FTS5 snippet())')
    .option('--with <list>', 'Federate search across registered siblings (name[,name…]|all)')
    .option('--json', 'Output as JSON')
    .action(
      (
        query: string,
        options: {
          type: string;
          limit: string;
          content?: boolean;
          snippets?: boolean;
          with?: string;
          json?: boolean;
        }
      ) => {
        const opts = program.opts();
        const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });

        // Guard the primary-index open (D3): the constructor prepares the FTS-join statements
        // eagerly (index.ts:84 → initQueries), so an absent/corrupt knowledge_entries_fts throws
        // HERE, before searchDocumentsRanked can classify it. Turn that prepare-time failure into a
        // clean `fts-unavailable` refusal (exit 1) rather than an uncaught crash. Search-scoped: only
        // `lux search` opens the DB this way; non-search commands' behavior on a corrupt index is
        // unchanged and out of scope. The guard sits above the branch split, so a broken primary
        // index refuses the federated invocation too.
        let db: LuxDatabase;
        try {
          db = new LuxDatabase(
            resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
          );
        } catch (openError) {
          const msg = openError instanceof Error ? openError.message : String(openError);
          // Only the DB-unavailable signatures refuse; a genuinely unexpected open failure rethrows
          // (never mask a real bug as fts-unavailable).
          if (
            !/no such table|no such column|no such module|not an fts5|malformed database|disk image is malformed|file is not a database/i.test(
              msg
            )
          ) {
            throw openError;
          }
          const refusal = {
            reason: 'fts-unavailable' as const,
            expression: query,
            message:
              'FTS5 search index is unavailable. Run `lux migrate up` and `lux index rebuild`, then try again.',
          };
          if (options.json) {
            console.log(
              JSON.stringify(
                buildSearchRefusalReport({
                  query,
                  type: options.type === 'knowledge' ? 'knowledge' : 'all',
                  contentOnly: options.content ?? false,
                  limit: Number.parseInt(options.limit, 10) || 0,
                  refusal,
                }),
                null,
                2
              )
            );
          } else {
            console.error(refusal.message);
          }
          // No usage event on this path: the constructor threw, so there is no DB handle to append
          // the event to (the events table may itself be part of what is unavailable). The honest
          // refusal + nonzero exit is the deliverable; the usage governor still sees query-time
          // refusals and zero-results on a healthy-enough index.
          process.exitCode = 1;
          return;
        }

        const invocationId = createInvocationId();
        const startedAt = Date.now();

        // Federated branch (Decision 5): opt-in via --with, strictly additive. Returns BEFORE the
        // shipped single-repo path, so a no-`--with` invocation (text + usage events) is unchanged
        // (SC-5). Sibling handles are read-only and closed in a finally (SC-7).
        if (options.with) {
          // Coerce the federated limit: after the re-source (spec 13) it flows straight into
          // `searchDocumentsRanked(query, { limit })` → `LIMIT ?`, so a NaN/<1/non-integer --limit
          // (which the old JS slice tolerated as an empty result) must not reach SQL. A malformed
          // federated --limit falls back to the shared default; the single-repo path below instead
          // rejects it as an exit-2 usage error. `coerceSearchLimit` is the one shared rule (M2).
          const limit = coerceSearchLimit(Number.parseInt(options.limit, 10));
          const primarySchema = db.getAppliedSchemaVersion();
          const names =
            options.with === 'all'
              ? ('all' as const)
              : options.with
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
          const resolutions = resolveSiblings(corpusPath, names, primarySchema);
          const handles: Array<{ name: string; db: LuxDatabase }> = [];
          // FIX 1: opening a resolved sibling runs AFTER resolve, so a post-resolve fault (TOCTOU
          // delete/re-index, cross-process busy-timeout, or a file that faults on re-open) must
          // degrade THAT sibling — not abort the whole federated search. Rewrite its resolution to a
          // refusal so the federation block stays consistent (attached:false + reason), warn, and
          // continue with the healthy handles. The finally below closes every opened handle (SC-7).
          const effectiveResolutions: SiblingResolution[] = [];
          try {
            for (const r of resolutions) {
              if (!('sibling' in r)) {
                // Decision 6: warn per unresolvable sibling, never silently drop.
                effectiveResolutions.push(r);
                console.error(`  ⚠ sibling '${r.name}': ${r.refusal.message}`);
                continue;
              }
              try {
                const handle = LuxDatabase.openSiblingReadOnly(r.sibling.dbPath, primarySchema);
                handles.push({ name: r.sibling.name, db: handle });
                effectiveResolutions.push(r);
              } catch (error) {
                const refusal = siblingFaultRefusal(r.sibling.name, error);
                effectiveResolutions.push({ name: r.sibling.name, refusal });
                console.error(`  ⚠ sibling '${r.sibling.name}': ${refusal.message}`);
              }
            }
            let fed;
            try {
              fed = runFederatedSearch(
                db,
                handles,
                query,
                buildFederationBlock(effectiveResolutions),
                limit
              );
            } catch (error) {
              if (!(error instanceof SearchRefusalError)) throw error; // genuinely unexpected
              // M1: an invalid FTS5 query fails identically for every group including `main`, so it is
              // a query-level refusal, NOT a per-sibling degrade. Surface the same structured refusal
              // as single-repo (exit 1, expression echoed) instead of a fabricated all-empty answer.
              if (options.json) {
                console.log(
                  JSON.stringify(
                    buildSearchRefusalReport({
                      query,
                      type: options.type === 'knowledge' ? 'knowledge' : 'all',
                      contentOnly: false,
                      limit,
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
                if (error.reason === 'invalid-query') {
                  console.error(`  FTS5 expression: ${error.expression}`);
                }
              }
              emitUsageEvent(db, {
                source: 'cli',
                surface: 'search',
                action: 'query',
                invocationId,
                commandOutcome: 'error',
                retrievalOutcome: 'refused',
                exitCode: 1,
                corpusPath,
                queryText: query,
                durationMs: Date.now() - startedAt,
                attributes: {
                  federated: true,
                  with: handles.map((h) => h.name),
                  type: options.type,
                  limit,
                },
                error: {
                  code: error.reason === 'invalid-query' ? 'invalid_query' : 'fts_unavailable',
                },
              });
              // The outer finally closes the sibling handles; close the primary here since this
              // refusal path returns before the shared `db.close()` below.
              db.close();
              process.exitCode = 1;
              return;
            }
            if (options.json) {
              console.log(JSON.stringify(fed, null, 2));
            } else {
              for (const g of fed.groups) {
                console.log(`\n[${g.repo}] (${g.results.length})`);
                for (const res of g.results) console.log(`  ${res.title}\n    ${res.path}`);
              }
            }
            emitUsageEvent(db, {
              source: 'cli',
              surface: 'search',
              action: 'query',
              invocationId,
              commandOutcome: 'success',
              // m7: now that invalid-query re-throws, a zero-result federated search is an honest miss,
              // not a refusal — derive answered/unresolved from union non-emptiness so federated misses
              // feed the usage-report repeated-miss clustering the same way single-repo ones do.
              retrievalOutcome: fed.groups.some((g) => g.results.length > 0)
                ? 'answered'
                : 'unresolved',
              exitCode: 0,
              corpusPath,
              queryText: query,
              durationMs: Date.now() - startedAt,
              attributes: {
                federated: true,
                with: handles.map((h) => h.name),
                type: options.type,
                limit,
              },
            });
          } finally {
            for (const h of handles) h.db.close();
          }
          db.close();
          return;
        }

        // ---- Single-repo path (D1–D5). Validate inputs up front (D3): a NaN --limit or an
        // unknown --type is a usage error (exit 2), never a fabricated empty answer. ----
        const type = options.type;
        if (type !== 'all' && type !== 'knowledge') {
          console.error(`Error: --type must be 'all' or 'knowledge' (got '${type}').`);
          emitUsageEvent(db, {
            source: 'cli',
            surface: 'search',
            action: 'query',
            invocationId,
            commandOutcome: 'error',
            retrievalOutcome: 'refused',
            durationMs: Date.now() - startedAt,
            exitCode: 2,
            corpusPath,
            queryText: query,
            attributes: { type, contentOnly: options.content ?? false },
            error: { code: 'invalid_type' },
          });
          db.close();
          process.exitCode = 2;
          return;
        }

        const parsedLimit = Number.parseInt(options.limit, 10);
        if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
          console.error(`Error: --limit must be a positive integer (got '${options.limit}').`);
          emitUsageEvent(db, {
            source: 'cli',
            surface: 'search',
            action: 'query',
            invocationId,
            commandOutcome: 'error',
            retrievalOutcome: 'refused',
            durationMs: Date.now() - startedAt,
            exitCode: 2,
            corpusPath,
            queryText: query,
            attributes: { type, contentOnly: options.content ?? false },
            error: { code: 'invalid_limit' },
          });
          db.close();
          process.exitCode = 2;
          return;
        }
        const contentOnly = options.content ?? false;

        // Run the ranked search, handle refusals (D1–D3).
        let results: RankedSearchResult[];
        try {
          results = db.searchDocumentsRanked(query, {
            contentOnly,
            snippets: options.snippets ?? false,
            limit: parsedLimit,
          });
        } catch (error) {
          if (error instanceof SearchRefusalError) {
            // D3: distinct, honest refusals — never `No results found`. Exit 1 on both classes.
            if (options.json) {
              const report = buildSearchRefusalReport({
                query,
                type,
                contentOnly,
                limit: parsedLimit,
                refusal: {
                  reason: error.reason,
                  expression: error.expression,
                  message: error.message,
                },
              });
              console.log(JSON.stringify(report, null, 2));
            } else {
              console.error(error.message);
              if (error.reason === 'invalid-query') {
                console.error(`  FTS5 expression: ${error.expression}`);
              }
            }
            emitUsageEvent(db, {
              source: 'cli',
              surface: 'search',
              action: 'query',
              invocationId,
              commandOutcome: 'error',
              retrievalOutcome: 'refused',
              durationMs: Date.now() - startedAt,
              exitCode: 1,
              corpusPath,
              queryText: query,
              attributes: { type, contentOnly, limit: parsedLimit },
              error: {
                code: error.reason === 'invalid-query' ? 'invalid_query' : 'fts_unavailable',
              },
            });
            db.close();
            process.exitCode = 1;
            return;
          }
          throw error; // genuinely unexpected — do not swallow
        }

        const retrievalOutcome = results.length > 0 ? 'answered' : 'unresolved';

        // Legacy search event (kept for continuity with the events table).
        db.insertEvent({
          source: 'cli',
          event_type: 'search',
          summary: `Search query: "${query}" (type: ${type}, content-only: ${contentOnly}, results: ${results.length})`,
          payload: {
            query,
            type,
            limit: parsedLimit,
            content_only: contentOnly,
            results_count: results.length,
          },
        });
        emitUsageEvent(db, {
          source: 'cli',
          surface: 'search',
          action: 'query',
          invocationId,
          commandOutcome: 'success',
          // D5: real outcome — feeds usage report's repeated-miss clustering (usage-report.ts:123-135).
          retrievalOutcome,
          durationMs: Date.now() - startedAt,
          exitCode: 0,
          corpusPath,
          queryText: query,
          attributes: { type, contentOnly, limit: parsedLimit, resultsCount: results.length },
        });

        if (options.json) {
          const report: SearchReportV1 = buildSearchReport({
            query,
            type,
            contentOnly,
            limit: parsedLimit,
            results,
          });
          console.log(JSON.stringify(report, null, 2));
          db.close();
          return;
        }

        if (results.length === 0) {
          console.log(
            `No results found for: ${query}${contentOnly ? ' (content-only search)' : ''}`
          );
          // Cross-surface hand-off (03 §The surface): symbols/entry points live on the anchor surface.
          console.log('  (symbols/entry points? try `lux anchors`.)');
          db.close();
          return;
        }

        // Module boundaries resolved once, only for source-code hits.
        const patterns = detectModuleBoundaries(corpusPath);
        const moduleCache = new Map<string, string | null>();
        const resolveFileModule = (filePath: string): string | null => {
          if (moduleCache.has(filePath)) return moduleCache.get(filePath)!;
          const mod = patterns.length > 0 ? resolveModule(filePath, corpusPath, patterns) : null;
          moduleCache.set(filePath, mod);
          return mod;
        };

        console.log(
          `\nSearch results for "${query}" (${results.length})${contentOnly ? ' - content-only search' : ''}:\n`
        );
        for (const result of results) {
          console.log(`[${result.entryType}] ${result.title}  (rank ${result.rank.toFixed(4)})`);
          console.log(`  Path: ${result.filePath}`);
          if (result.snippet) console.log(`  Snippet: ${result.snippet}`);

          if (result.entryType === 'source-code') {
            const mod = resolveFileModule(result.filePath);
            if (mod) {
              console.log(`  Module: ${mod}`);
              const dependents = db.getModuleDependencies(mod, 'target');
              if (dependents.length > 0) {
                const depSummary = dependents
                  .slice(0, 5)
                  .map((d) => `${d.source_module} (${d.reference_count} refs)`)
                  .join(', ');
                console.log(`  Depended on by: ${depSummary}`);
              }
            }
          }
          console.log();
        }

        db.close();
      }
    );
}
