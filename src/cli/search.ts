import { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';

export function addSearchCommand(program: Command) {
  program
    .command('search <query>')
    .description('Search all indexed documents using full-text search')
    .option('--type <type>', 'Filter by entity type (all|knowledge)', 'all')
    .option('--limit <n>', 'Limit results', '20')
    .option('--content', 'Search only file content (not metadata)')
    .option('--legacy', 'Use legacy substring search instead of FTS5')
    .action(
      (
        query: string,
        options: {
          type: string;
          limit: string;
          content?: boolean;
          legacy?: boolean;
        }
      ) => {
        const opts = program.opts();
        const db = new LuxDatabase(opts.db as string);

        const limit = parseInt(options.limit, 10);
        const results: Array<{
          type: string;
          title: string;
          path: string;
          context?: string;
        }> = [];

        // Use FTS5 search by default (unless --legacy flag is set)
        if (!options.legacy) {
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
            // If FTS5 fails (e.g., schema not migrated), fall back to legacy search
            console.error(
              'FTS5 search failed, falling back to legacy search:',
              (error as Error).message
            );
            performLegacySearch(db, query, options, results);
          }
        } else {
          // Legacy substring search
          performLegacySearch(db, query, options, results);
        }

        // Limit results
        const limitedResults = results.slice(0, limit);

        // Log search event
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

        if (limitedResults.length === 0) {
          console.log(
            `No results found for: ${query}${options.content ? ' (content-only search)' : ''}`
          );
          db.close();
          return;
        }

        console.log(
          `\nSearch results for "${query}" (${limitedResults.length})${options.content ? ' - content-only search' : ''}:\n`
        );
        for (const result of limitedResults) {
          console.log(`[${result.type}] ${result.title}`);
          if (result.context) console.log(`  Context: ${result.context}`);
          console.log(`  Path: ${result.path}`);
          console.log();
        }

        db.close();
      }
    );
}

/**
 * Legacy substring search implementation (pre-FTS5).
 * Used as fallback when FTS5 is not available or --legacy flag is set.
 */
function performLegacySearch(
  db: LuxDatabase,
  query: string,
  options: { type: string },
  results: Array<{
    type: string;
    title: string;
    path: string;
    context?: string;
  }>
) {
  const searchQuery = query.toLowerCase();

  // Helper function to search in metadata JSON
  const searchMetadata = (metadataStr: string | null | undefined): boolean => {
    if (!metadataStr) return false;
    try {
      const metadata = JSON.parse(metadataStr) as Record<string, unknown>;
      const metadataText = JSON.stringify(metadata).toLowerCase();
      return metadataText.includes(searchQuery);
    } catch {
      return false;
    }
  };

  // Search knowledge entries
  if (options.type === 'all' || options.type === 'knowledge') {
    const allKnowledge = db.getAllKnowledgeEntries();

    for (const entry of allKnowledge) {
      const tags = entry.tags ?? '';
      if (
        entry.title.toLowerCase().includes(searchQuery) ||
        entry.type.toLowerCase().includes(searchQuery) ||
        tags.toLowerCase().includes(searchQuery) ||
        searchMetadata(entry.metadata)
      ) {
        results.push({
          type: 'knowledge',
          title: entry.title,
          path: entry.file_path,
          context: entry.type,
        });
      }
    }
  }
}
