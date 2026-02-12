import { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';

export function addSearchCommand(program: Command) {
  program
    .command('search <query>')
    .description('Search clients, projects, communications, and knowledge')
    .option('--client <slug>', 'Filter by client')
    .option(
      '--type <type>',
      'Filter by entity type (client|project|comm|knowledge)',
      'all'
    )
    .option('--limit <n>', 'Limit results', '20')
    .action((query: string, options: { client?: string; type: string; limit: string }) => {
      const opts = program.opts();
      const db = new LuxDatabase(opts.db as string);

      const searchQuery = query.toLowerCase();
      const limit = parseInt(options.limit, 10);
      const results: Array<{
        type: string;
        title: string;
        slug?: string;
        path: string;
        context?: string;
      }> = [];

      // Search clients
      if (options.type === 'all' || options.type === 'client') {
        const clients = db.getAllClients();
        for (const client of clients) {
          if (
            client.slug.toLowerCase().includes(searchQuery) ||
            client.name.toLowerCase().includes(searchQuery)
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
              project.name.toLowerCase().includes(searchQuery)
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
            if (
              subject.toLowerCase().includes(searchQuery) ||
              comm.type.toLowerCase().includes(searchQuery)
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
          if (
            entry.title.toLowerCase().includes(searchQuery) ||
            entry.type.toLowerCase().includes(searchQuery)
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

      // Limit results
      const limitedResults = results.slice(0, limit);

      if (limitedResults.length === 0) {
        console.log(`No results found for: ${query}`);
        db.close();
        return;
      }

      console.log(`\nSearch results for "${query}" (${limitedResults.length}):\n`);
      for (const result of limitedResults) {
        console.log(`[${result.type}] ${result.title}`);
        if (result.slug) console.log(`  Slug: ${result.slug}`);
        if (result.context) console.log(`  Context: ${result.context}`);
        console.log(`  Path: ${result.path}`);
        console.log();
      }

      db.close();
    });
}
