import { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';
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
    .option('--with <list>', 'Federate search across registered siblings (name[,name…]|all)')
    .option('--json', 'Output as JSON')
    .action(
      (
        query: string,
        options: {
          type: string;
          limit: string;
          content?: boolean;
          with?: string;
          json?: boolean;
        }
      ) => {
        const opts = program.opts();
        const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
        const db = new LuxDatabase(
          resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
        );

        const limit = parseInt(options.limit, 10);
        const invocationId = createInvocationId();
        const startedAt = Date.now();

        // Federated branch (Decision 5): opt-in via --with, strictly additive. Returns BEFORE the
        // shipped single-repo path, so a no-`--with` invocation (text + usage events) is unchanged
        // (SC-5). Sibling handles are read-only and closed in a finally (SC-7).
        if (options.with) {
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
            const fed = runFederatedSearch(
              db,
              handles,
              query,
              buildFederationBlock(effectiveResolutions),
              limit
            );
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
              retrievalOutcome: 'not_applicable',
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

        const results: Array<{
          type: string;
          title: string;
          path: string;
          context?: string;
        }> = [];

        try {
          if (options.type === 'all') {
            // Unified document search across all entity types
            const docs = db.searchAllDocuments(query);
            for (const doc of docs) {
              results.push({
                type: 'document',
                title: doc.title,
                path: doc.file_path,
              });
            }
          } else if (options.type === 'knowledge') {
            const searchKnowledgeEntries = options.content
              ? db.searchKnowledgeEntriesContent.bind(db)
              : db.searchKnowledgeEntries.bind(db);

            const entries = searchKnowledgeEntries(query);
            for (const entry of entries) {
              results.push({
                type: 'knowledge',
                title: entry.title,
                path: entry.file_path,
                context: entry.type,
              });
            }
          }
        } catch (error) {
          console.error('FTS5 search unavailable:', (error as Error).message);
          console.error('Run `lux migrate up` and `lux index rebuild`, then try again.');
          emitUsageEvent(db, {
            source: 'cli',
            surface: 'search',
            action: 'query',
            invocationId,
            commandOutcome: 'error',
            retrievalOutcome: 'not_applicable',
            durationMs: Date.now() - startedAt,
            exitCode: 1,
            corpusPath,
            queryText: query,
            attributes: { type: options.type, contentOnly: options.content ?? false },
            error: { code: 'fts_unavailable' },
          });
          db.close();
          process.exitCode = 1;
          return;
        }

        // Limit results
        const limitedResults = results.slice(0, limit);

        // Log legacy search event and normalized usage event.
        db.insertEvent({
          source: 'cli',
          event_type: 'search',
          summary: `Search query: "${query}" (type: ${options.type}, content-only: ${options.content ?? false}, results: ${limitedResults.length})`,
          payload: {
            query,
            type: options.type,
            limit: limit,
            content_only: options.content ?? false,
            results_count: limitedResults.length,
            total_matches: results.length,
          },
        });
        emitUsageEvent(db, {
          source: 'cli',
          surface: 'search',
          action: 'query',
          invocationId,
          commandOutcome: 'success',
          retrievalOutcome: 'not_applicable',
          durationMs: Date.now() - startedAt,
          exitCode: 0,
          corpusPath,
          queryText: query,
          attributes: {
            type: options.type,
            limit,
            contentOnly: options.content ?? false,
            resultsCount: limitedResults.length,
            totalMatches: results.length,
          },
        });

        // FIX 4: honor `--json` on the single-repo path too. Previously `--json` was read only inside
        // the `--with` branch, so `lux search foo --json` (no `--with`) parsed the flag and silently
        // dropped it (text out, exit 0) — on main it errored as an unknown option. Emit the ranked
        // results as JSON, matching the MCP single-repo `lux_search` shape (a plain array of
        // {type,title,path,context?}); `[]` when empty. The no-`--json` text path below is untouched.
        if (options.json) {
          console.log(JSON.stringify(limitedResults, null, 2));
          db.close();
          return;
        }

        if (limitedResults.length === 0) {
          console.log(
            `No results found for: ${query}${options.content ? ' (content-only search)' : ''}`
          );
          db.close();
          return;
        }

        // Detect module boundaries once for all results
        const patterns = detectModuleBoundaries(corpusPath);
        const moduleCache = new Map<string, string | null>();

        const resolveFileModule = (filePath: string): string | null => {
          if (moduleCache.has(filePath)) return moduleCache.get(filePath)!;
          const mod = patterns.length > 0 ? resolveModule(filePath, corpusPath, patterns) : null;
          moduleCache.set(filePath, mod);
          return mod;
        };

        console.log(
          `\nSearch results for "${query}" (${limitedResults.length})${options.content ? ' - content-only search' : ''}:\n`
        );
        for (const result of limitedResults) {
          console.log(`[${result.type}] ${result.title}`);
          if (result.context) console.log(`  Context: ${result.context}`);
          console.log(`  Path: ${result.path}`);

          // Module annotation for source-code results
          if (result.context === 'source-code') {
            const mod = resolveFileModule(result.path);
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
