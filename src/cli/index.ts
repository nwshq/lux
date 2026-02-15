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
import { addMigrateCommands } from './migrate.js';
import { addLintCommand } from './lint.js';

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
  .description('Show client details and all associated file paths')
  .action((slug: string) => {
    const opts = program.opts();
    const db = new LuxDatabase(opts.db as string);
    const client = db.getClient(slug);

    if (!client) {
      console.error(`Client not found: ${slug}`);
      db.close();
      process.exit(1);
    }

    // Client details
    console.log(`\nClient: ${client.name}`);
    console.log(`Slug: ${client.slug}`);
    if (client.type) console.log(`Type: ${client.type}`);
    if (client.status) console.log(`Status: ${client.status}`);
    console.log(`File: ${client.file_path}`);

    // Projects with file paths
    const projects = db.getProjectsByClient(client.id);
    if (projects.length > 0) {
      console.log(`\nProjects (${projects.length}):`);
      for (const project of projects) {
        console.log(`  ${project.slug}: ${project.name}`);
        if (project.status) console.log(`    Status: ${project.status}`);
        console.log(`    File: ${project.file_path}`);
      }
    }

    // Communications with file paths
    const comms = db.getCommunicationsByClient(client.id);
    if (comms.length > 0) {
      console.log(`\nCommunications (${comms.length}):`);
      for (const comm of comms) {
        console.log(`  [${comm.type}] ${comm.subject ?? 'Untitled'}`);
        if (comm.date_range) console.log(`    Date: ${comm.date_range}`);
        console.log(`    File: ${comm.file_path}`);
      }
    }

    // Knowledge entries with file paths
    const knowledge = db.getKnowledgeEntriesByClient(client.id);
    if (knowledge.length > 0) {
      console.log(`\nKnowledge Entries (${knowledge.length}):`);
      for (const entry of knowledge) {
        console.log(`  [${entry.type}] ${entry.title}`);
        console.log(`    File: ${entry.file_path}`);
      }
    }

    // Summary of all file paths
    const allPaths = [
      client.file_path,
      ...projects.map((p) => p.file_path),
      ...comms.map((c) => c.file_path),
      ...knowledge.map((k) => k.file_path),
    ];
    console.log(`\nAll Files (${allPaths.length}):`);
    for (const path of allPaths) {
      console.log(`  ${path}`);
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
  .description('Show project details and all associated file paths')
  .option('--client <slug>', 'Client slug (optional if project slug is unique)')
  .action((projectSlug: string, options: { client?: string }) => {
    const opts = program.opts();
    const db = new LuxDatabase(opts.db as string);

    let project;
    let client;

    if (options.client) {
      // Use the old method if client is specified
      project = db.getProject(options.client, projectSlug);
      if (project) {
        client = db.getClient(options.client);
      }
    } else {
      // Search by project slug alone
      const result = db.getProjectBySlug(projectSlug);
      if (result) {
        project = result;
        client = { slug: result.client_slug, name: result.client_name };
      }
    }

    if (!project) {
      if (options.client) {
        console.error(`Project not found: ${options.client}/${projectSlug}`);
      } else {
        console.error(`Project not found: ${projectSlug}`);
        console.error('If multiple projects have this slug, specify --client <slug>');
      }
      db.close();
      process.exit(1);
    }

    // Project details
    console.log(`\nProject: ${project.name}`);
    console.log(`Slug: ${project.slug}`);
    console.log(`Client: ${client?.name} (${client?.slug})`);
    if (project.status) console.log(`Status: ${project.status}`);
    console.log(`File: ${project.file_path}`);

    // Communications with file paths
    const comms = db.getCommunicationsByProject(project.id);
    if (comms.length > 0) {
      console.log(`\nCommunications (${comms.length}):`);
      for (const comm of comms) {
        console.log(`  [${comm.type}] ${comm.subject ?? 'Untitled'}`);
        if (comm.date_range) console.log(`    Date: ${comm.date_range}`);
        console.log(`    File: ${comm.file_path}`);
      }
    }

    // Knowledge entries with file paths
    const knowledge = db.getKnowledgeEntriesByProject(project.id);
    if (knowledge.length > 0) {
      console.log(`\nKnowledge Entries (${knowledge.length}):`);
      for (const entry of knowledge) {
        console.log(`  [${entry.type}] ${entry.title}`);
        console.log(`    File: ${entry.file_path}`);
      }
    }

    // Summary of all file paths
    const allPaths = [
      project.file_path,
      ...comms.map((c) => c.file_path),
      ...knowledge.map((k) => k.file_path),
    ];
    console.log(`\nAll Files (${allPaths.length}):`);
    for (const path of allPaths) {
      console.log(`  ${path}`);
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
    let db: LuxDatabase | undefined;

    try {
      // Validate CORPUS directory
      if (!existsSync(corpusPath)) {
        console.error(`Error: CORPUS directory not found: ${corpusPath}`);
        console.error('  Please ensure the directory exists or set --corpus <path>');
        process.exit(1);
      }

      // Initialize database with error handling
      try {
        db = new LuxDatabase(opts.db as string);
      } catch (error) {
        console.error(`Error: Failed to initialize database: ${opts.db}`);
        console.error(`  ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }

      // Verify database schema is up to date
      if (!db.isSchemaUpToDate()) {
        console.error('Error: Database schema is not up to date');
        console.error('  Run "lux migrate" to update the schema');
        db.close();
        process.exit(1);
      }

      const scanner = new CorpusScanner(corpusPath);

      if (!options.quiet) {
        console.log(`Scanning CORPUS at: ${corpusPath}`);
      }

      // Scan CORPUS with error handling
      let result;
      try {
        result = await scanner.scan();
      } catch (error) {
        console.error('Error: Failed to scan CORPUS directory');
        console.error(`  ${error instanceof Error ? error.message : String(error)}`);
        db.close();
        process.exit(1);
      }

      // Validate scan results
      if (!result || typeof result !== 'object') {
        console.error('Error: Invalid scan result');
        db.close();
        process.exit(1);
      }

      if (!options.quiet) {
        console.log(`Found:`);
        console.log(`  - ${result.clients.length} clients`);
        console.log(`  - ${result.projects.length} projects`);
        console.log(`  - ${result.communications.length} communications`);
        console.log(`  - ${result.knowledge.length} knowledge entries`);
        console.log(`\nClearing existing index...`);
      }

      // Clear database with error handling
      try {
        db.clearAll();
      } catch (error) {
        console.error('Error: Failed to clear existing index');
        console.error(`  ${error instanceof Error ? error.message : String(error)}`);
        db.close();
        process.exit(1);
      }

      if (!options.quiet) {
        console.log('Indexing...');
      }

      // Index with comprehensive error handling
      try {
        await scanner.index(db, result);
      } catch (error) {
        console.error('Error: Failed to index CORPUS content');
        if (error instanceof Error) {
          console.error(`  ${error.message}`);
          // Provide helpful context for common errors
          if (error.message.includes('Client not found')) {
            console.error('  This suggests inconsistent CORPUS structure');
            console.error('  Verify that all projects reference existing clients');
          } else if (error.message.includes('UNIQUE constraint')) {
            console.error('  This suggests duplicate entries in your CORPUS');
            console.error('  Check for duplicate client/project slugs');
          } else if (error.message.includes('FOREIGN KEY constraint')) {
            console.error('  This suggests missing parent entities');
            console.error('  Verify that all relationships are valid');
          }
        } else {
          console.error(`  ${String(error)}`);
        }
        db.close();
        process.exit(1);
      }

      // Log event with error handling
      try {
        db.insertEvent({
          source: 'cli',
          event_type: 'index_rebuild',
          summary: `Indexed ${result.clients.length} clients, ${result.projects.length} projects, ${result.communications.length} communications, ${result.knowledge.length} knowledge entries`,
        });
      } catch {
        // Non-fatal: log but don't fail
        if (!options.quiet) {
          console.warn('Warning: Failed to log rebuild event');
        }
      }

      if (!options.quiet) {
        console.log('✓ Index rebuilt successfully');
      }

      db.close();
    } catch (error) {
      // Catch-all for unexpected errors
      console.error('Error: Unexpected error during index rebuild');
      console.error(`  ${error instanceof Error ? error.message : String(error)}`);
      if (db) {
        try {
          db.close();
        } catch {
          // Ignore close errors
        }
      }
      process.exit(1);
    }
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

// Add migration commands
addMigrateCommands(program);

// Add lint command
addLintCommand(program);

program.parse();
