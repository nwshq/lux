import { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';

export function addSearchCommand(program: Command) {
  program
    .command('search <query>')
    .description('Search clients, projects, communications, and knowledge using full-text search')
    .option('--client <slug>', 'Filter by client')
    .option('--type <type>', 'Filter by entity type (client|project|comm|knowledge)', 'all')
    .option('--limit <n>', 'Limit results', '20')
    .option('--content', 'Search only file content (not metadata)')
    .option('--legacy', 'Use legacy substring search instead of FTS5')
    .action(
      (
        query: string,
        options: {
          client?: string;
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
          slug?: string;
          path: string;
          context?: string;
          rank?: number;
        }> = [];

        // Use FTS5 search by default (unless --legacy flag is set)
        if (!options.legacy) {
          // FTS5 search - much faster and more sophisticated
          // Supports phrase search, prefix matching, boolean operators
          try {
            // Determine which search methods to use based on --content flag
            const searchClients = options.content
              ? db.searchClientsContent.bind(db)
              : db.searchClients.bind(db);
            const searchProjects = options.content
              ? db.searchProjectsContent.bind(db)
              : db.searchProjects.bind(db);
            const searchCommunications = options.content
              ? db.searchCommunicationsContent.bind(db)
              : db.searchCommunications.bind(db);
            const searchKnowledgeEntries = options.content
              ? db.searchKnowledgeEntriesContent.bind(db)
              : db.searchKnowledgeEntries.bind(db);

            // Search clients
            if (options.type === 'all' || options.type === 'client') {
              const clients = searchClients(query);
              for (const client of clients) {
                results.push({
                  type: 'client',
                  title: client.name,
                  slug: client.slug,
                  path: client.file_path,
                  context: client.status,
                });
              }
            }

            // Search projects
            if (options.type === 'all' || options.type === 'project') {
              const projects = searchProjects(query);
              for (const project of projects) {
                // Filter by client if specified
                if (options.client && project.client_slug !== options.client) continue;

                results.push({
                  type: 'project',
                  title: `${project.client_slug}/${project.name}`,
                  slug: project.slug,
                  path: project.file_path,
                  context: project.status,
                });
              }
            }

            // Search communications
            if (options.type === 'all' || options.type === 'comm') {
              const communications = searchCommunications(query);
              for (const comm of communications) {
                // Filter by client if specified
                if (options.client) {
                  const client = db.getAllClients().find((c) => c.id === comm.client_id);
                  if (!client || client.slug !== options.client) continue;
                }

                const subject = comm.subject ?? '';
                results.push({
                  type: 'communication',
                  title: `[${comm.type}] ${subject}`,
                  path: comm.file_path,
                  context: comm.date_range,
                });
              }
            }

            // Search knowledge entries
            if (options.type === 'all' || options.type === 'knowledge') {
              const entries = searchKnowledgeEntries(query);
              for (const entry of entries) {
                // Filter by client if specified
                if (options.client && entry.client_id) {
                  const client = db.getAllClients().find((c) => c.id === entry.client_id);
                  if (!client || client.slug !== options.client) continue;
                }

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
            client: options.client,
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
          if (result.slug) console.log(`  Slug: ${result.slug}`);
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
  options: { client?: string; type: string },
  results: Array<{
    type: string;
    title: string;
    slug?: string;
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

  // Search clients
  if (options.type === 'all' || options.type === 'client') {
    const clients = db.getAllClients();
    for (const client of clients) {
      if (
        client.slug.toLowerCase().includes(searchQuery) ||
        client.name.toLowerCase().includes(searchQuery) ||
        client.type?.toLowerCase().includes(searchQuery) ||
        client.status?.toLowerCase().includes(searchQuery) ||
        searchMetadata(client.metadata)
      ) {
        results.push({
          type: 'client',
          title: client.name,
          slug: client.slug,
          path: client.file_path,
          context: client.status,
        });
      }
    }
  }

  // Search projects
  if (options.type === 'all' || options.type === 'project') {
    const clients = options.client
      ? [db.getClient(options.client)].filter((c) => c !== undefined)
      : db.getAllClients();

    for (const client of clients) {
      if (!client) continue;
      const projects = db.getProjectsByClient(client.id);
      for (const project of projects) {
        if (
          project.slug.toLowerCase().includes(searchQuery) ||
          project.name.toLowerCase().includes(searchQuery) ||
          project.status?.toLowerCase().includes(searchQuery) ||
          searchMetadata(project.metadata)
        ) {
          results.push({
            type: 'project',
            title: `${client.slug}/${project.name}`,
            slug: project.slug,
            path: project.file_path,
            context: project.status,
          });
        }
      }
    }
  }

  // Search communications
  if (options.type === 'all' || options.type === 'comm') {
    const clients = options.client
      ? [db.getClient(options.client)].filter((c) => c !== undefined)
      : db.getAllClients();

    for (const client of clients) {
      if (!client) continue;
      const comms = db.getCommunicationsByClient(client.id);
      for (const comm of comms) {
        const subject = comm.subject ?? '';
        const participants = comm.participants ?? '';
        if (
          subject.toLowerCase().includes(searchQuery) ||
          comm.type.toLowerCase().includes(searchQuery) ||
          comm.date_range?.toLowerCase().includes(searchQuery) ||
          participants.toLowerCase().includes(searchQuery) ||
          searchMetadata(comm.metadata)
        ) {
          results.push({
            type: 'communication',
            title: `[${comm.type}] ${subject}`,
            path: comm.file_path,
            context: comm.date_range,
          });
        }
      }
    }
  }

  // Search knowledge entries
  if (options.type === 'all' || options.type === 'knowledge') {
    const allKnowledge = db
      .getKnowledgeEntriesByType('methodology')
      .concat(db.getKnowledgeEntriesByType('spec'))
      .concat(db.getKnowledgeEntriesByType('architecture'))
      .concat(db.getKnowledgeEntriesByType('exploration'))
      .concat(db.getKnowledgeEntriesByType('implementation-payload'))
      .concat(db.getKnowledgeEntriesByType('general'));

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
