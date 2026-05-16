import { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';
import { detectModuleBoundaries, resolveModule } from '../scanner/imports/module-boundary.js';
import { emitUsageEvent, createInvocationId } from '../db/observability/usage-event.js';
import { resolveCorpusPath, resolveDbPath } from '../utils/runtime-paths.js';

export function addSearchCommand(program: Command) {
  program
    .command('search <query>')
    .description('Search all indexed documents using full-text search')
    .option('--type <type>', 'Filter by entity type (all|knowledge)', 'all')
    .option('--limit <n>', 'Limit results', '20')
    .option('--content', 'Search only file content (not metadata)')
    .action(
      (
        query: string,
        options: {
          type: string;
          limit: string;
          content?: boolean;
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
