#!/usr/bin/env node

import { Command } from 'commander';
import { join } from 'path';
import { homedir } from 'os';
import { LuxDatabase } from '../db/index.js';
import { CorpusScanner } from '../scanner/index.js';
import { existsSync } from 'fs';
import { addCommCommands } from './comm.js';
import { addSearchCommand } from './search.js';
import { addHooksCommand } from './hooks.js';

const program = new Command();

// Global options
const DEFAULT_DB_PATH = join(homedir(), '.lux', 'lux.db');
const DEFAULT_CORPUS_PATH = join(homedir(), 'CORPUS');

program
  .name('lux')
  .description('Lux Knowledge Platform - CORPUS semantic search and knowledge retrieval')
  .version('0.1.0')
  .option('--db <path>', 'Database path', DEFAULT_DB_PATH)
  .option('--corpus <path>', 'CORPUS directory path', DEFAULT_CORPUS_PATH);

// Client commands
const clientCmd = program.command('client').description('Manage clients');

clientCmd
  .command('list')
  .description('List all clients')
  .action(() => {
    const opts = program.opts();
    const db = new LuxDatabase(opts.db as string);
    const clients = db.getAllClients();

    if (clients.length === 0) {
      console.log('No clients found. Run "lux index rebuild" to scan CORPUS.');
      db.close();
      return;
    }

    console.log(`\nClients (${clients.length}):\n`);
    for (const client of clients) {
      console.log(`  ${client.slug}`);
      console.log(`    Name: ${client.name}`);
      if (client.status) console.log(`    Status: ${client.status}`);
      console.log(`    Path: ${client.file_path}`);
      console.log();
    }
    db.close();
  });

clientCmd
  .command('show <slug>')
  .description('Show client details')
  .action((slug: string) => {
    const opts = program.opts();
    const db = new LuxDatabase(opts.db as string);
    const client = db.getClient(slug);

    if (!client) {
      console.error(`Client not found: ${slug}`);
      db.close();
      process.exit(1);
    }

    console.log(`\nClient: ${client.name}`);
    console.log(`Slug: ${client.slug}`);
    if (client.type) console.log(`Type: ${client.type}`);
    if (client.status) console.log(`Status: ${client.status}`);
    console.log(`Path: ${client.file_path}`);

    const projects = db.getProjectsByClient(client.id);
    if (projects.length > 0) {
      console.log(`\nProjects (${projects.length}):`);
      for (const project of projects) {
        console.log(`  - ${project.slug}: ${project.name}`);
      }
    }

    const comms = db.getCommunicationsByClient(client.id);
    if (comms.length > 0) {
      console.log(`\nRecent communications (${comms.length}):`);
      for (const comm of comms.slice(0, 5)) {
        console.log(`  - [${comm.type}] ${comm.subject ?? 'Untitled'}`);
        if (comm.date_range) console.log(`    Date: ${comm.date_range}`);
      }
    }

    db.close();
  });

// Project commands
const projectCmd = program.command('project').description('Manage projects');

projectCmd
  .command('list')
  .description('List projects for a client')
  .requiredOption('--client <slug>', 'Client slug')
  .action((options: { client: string }) => {
    const opts = program.opts();
    const db = new LuxDatabase(opts.db as string);
    const client = db.getClient(options.client);

    if (!client) {
      console.error(`Client not found: ${options.client}`);
      db.close();
      process.exit(1);
    }

    const projects = db.getProjectsByClient(client.id);

    if (projects.length === 0) {
      console.log(`No projects found for client: ${client.name}`);
      db.close();
      return;
    }

    console.log(`\nProjects for ${client.name} (${projects.length}):\n`);
    for (const project of projects) {
      console.log(`  ${project.slug}`);
      console.log(`    Name: ${project.name}`);
      if (project.status) console.log(`    Status: ${project.status}`);
      console.log(`    Path: ${project.file_path}`);
      console.log();
    }
    db.close();
  });

projectCmd
  .command('show <slug>')
  .description('Show project details')
  .requiredOption('--client <slug>', 'Client slug')
  .action((projectSlug: string, options: { client: string }) => {
    const opts = program.opts();
    const db = new LuxDatabase(opts.db as string);
    const project = db.getProject(options.client, projectSlug);

    if (!project) {
      console.error(`Project not found: ${options.client}/${projectSlug}`);
      db.close();
      process.exit(1);
    }

    console.log(`\nProject: ${project.name}`);
    console.log(`Slug: ${project.slug}`);
    if (project.status) console.log(`Status: ${project.status}`);
    console.log(`Path: ${project.file_path}`);

    const comms = db.getCommunicationsByProject(project.id);
    if (comms.length > 0) {
      console.log(`\nCommunications (${comms.length}):`);
      for (const comm of comms.slice(0, 5)) {
        console.log(`  - [${comm.type}] ${comm.subject ?? 'Untitled'}`);
        if (comm.date_range) console.log(`    Date: ${comm.date_range}`);
      }
    }

    db.close();
  });

// Index commands
const indexCmd = program.command('index').description('Manage index');

indexCmd
  .command('rebuild')
  .description('Rebuild index from CORPUS')
  .option('--quiet', 'Suppress output')
  .action(async (options: { quiet?: boolean }) => {
    const opts = program.opts();
    const corpusPath = opts.corpus as string;

    if (!existsSync(corpusPath)) {
      console.error(`CORPUS directory not found: ${corpusPath}`);
      process.exit(1);
    }

    const db = new LuxDatabase(opts.db as string);
    const scanner = new CorpusScanner(corpusPath);

    if (!options.quiet) {
      console.log(`Scanning CORPUS at: ${corpusPath}`);
    }

    const result = await scanner.scan();

    if (!options.quiet) {
      console.log(`Found:`);
      console.log(`  - ${result.clients.length} clients`);
      console.log(`  - ${result.projects.length} projects`);
      console.log(`  - ${result.communications.length} communications`);
      console.log(`  - ${result.knowledge.length} knowledge entries`);
      console.log(`\nClearing existing index...`);
    }

    db.clearAll();

    if (!options.quiet) {
      console.log('Indexing...');
    }

    // Index clients
    const clientMap = new Map<string, number>();
    for (const client of result.clients) {
      const id = db.insertClient({
        slug: client.slug,
        name: client.name,
        type: client.type,
        status: client.status,
        file_path: client.filePath,
        metadata: client.frontmatter,
      });
      clientMap.set(client.slug, id);
    }

    // Index projects
    const projectMap = new Map<string, number>();
    for (const project of result.projects) {
      const clientId = clientMap.get(project.clientSlug);
      if (!clientId) continue;

      const id = db.insertProject({
        client_id: clientId,
        slug: project.slug,
        name: project.name,
        status: project.status,
        file_path: project.filePath,
        metadata: project.frontmatter,
      });
      projectMap.set(`${project.clientSlug}/${project.slug}`, id);
    }

    // Index communications
    for (const comm of result.communications) {
      const clientId = clientMap.get(comm.clientSlug);
      if (!clientId) continue;

      const projectId = comm.projectSlug
        ? projectMap.get(`${comm.clientSlug}/${comm.projectSlug}`)
        : undefined;

      db.insertCommunication({
        client_id: clientId,
        project_id: projectId,
        type: comm.type,
        subject: comm.subject,
        date_range: comm.dateRange,
        participants: comm.participants,
        file_path: comm.filePath,
        metadata: comm.frontmatter,
      });
    }

    // Index knowledge entries
    for (const entry of result.knowledge) {
      const clientId = entry.clientSlug ? clientMap.get(entry.clientSlug) : undefined;
      const projectId =
        entry.clientSlug && entry.projectSlug
          ? projectMap.get(`${entry.clientSlug}/${entry.projectSlug}`)
          : undefined;

      db.insertKnowledgeEntry({
        client_id: clientId,
        project_id: projectId,
        type: entry.type,
        title: entry.title,
        file_path: entry.filePath,
        tags: entry.tags,
        metadata: entry.frontmatter,
      });
    }

    // Log event
    db.insertEvent({
      source: 'cli',
      event_type: 'index_rebuild',
      summary: `Indexed ${result.clients.length} clients, ${result.projects.length} projects, ${result.communications.length} communications, ${result.knowledge.length} knowledge entries`,
    });

    if (!options.quiet) {
      console.log('✓ Index rebuilt successfully');
    }

    db.close();
  });

indexCmd
  .command('status')
  .description('Show index statistics')
  .action(() => {
    const opts = program.opts();
    const db = new LuxDatabase(opts.db as string);
    const stats = db.getStats();

    console.log('\nIndex Statistics:\n');
    console.log(`  Clients: ${stats.clients}`);
    console.log(`  Projects: ${stats.projects}`);
    console.log(`  Communications: ${stats.communications}`);
    console.log(`  Knowledge Entries: ${stats.knowledge_entries}`);
    console.log(`  Events: ${stats.events}`);
    console.log();

    db.close();
  });

// Add communication commands
addCommCommands(program);

// Add search command
addSearchCommand(program);

// Add hooks command
addHooksCommand(program);

program.parse();
