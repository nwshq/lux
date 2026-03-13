#!/usr/bin/env node

import { Command } from 'commander';
import { join } from 'path';
import { homedir } from 'os';
import { LuxDatabase } from '../db/index.js';
import { GeneralScanner } from '../scanner/index.js';
import { generalScan, attachEnrichment } from '../scanner/general.js';
import { existsSync } from 'fs';
import { addSearchCommand } from './search.js';
import { addHooksCommand } from './hooks.js';
import { addMigrateCommands } from './migrate.js';
import { addLintCommand } from './lint.js';
import { addExpertCommands } from './expert.js';
import { addAskCommand } from './ask.js';

const program = new Command();

// Global options
const DEFAULT_DB_PATH = join(homedir(), '.lux', 'lux.db');
const DEFAULT_CORPUS_PATH = join(homedir(), 'CORPUS');

program
  .name('lux')
  .description('Lux Knowledge Platform - semantic search and knowledge retrieval')
  .version('0.1.0')
  .option('--db <path>', 'Database path', DEFAULT_DB_PATH)
  .option('--corpus <path>', 'Content root directory path', DEFAULT_CORPUS_PATH);

// Index commands
const indexCmd = program.command('index').description('Manage index');

indexCmd
  .command('rebuild')
  .description('Rebuild index from content directory')
  .option('--quiet', 'Suppress output')
  .action(async (options: { quiet?: boolean }) => {
    const opts = program.opts();
    const corpusPath = opts.corpus as string;
    let db: LuxDatabase | undefined;

    try {
      // Validate content directory
      if (!existsSync(corpusPath)) {
        console.error(`Error: Content directory not found: ${corpusPath}`);
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

      const scanner = new GeneralScanner(corpusPath);

      if (!options.quiet) {
        console.log(`Scanning content directory: ${corpusPath}`);
      }

      // Scan content directory with LSP enrichment pipeline
      let generalResult;
      try {
        generalResult = await generalScan(corpusPath, {
          onProgress: options.quiet ? undefined : (msg) => console.log(`  ${msg}`),
        });
      } catch (error) {
        console.error('Error: Failed to scan content directory');
        console.error(`  ${error instanceof Error ? error.message : String(error)}`);
        db.close();
        process.exit(1);
      }

      // Attach enrichment data to each knowledge entry
      const result = {
        ...generalResult.scan,
        knowledge: generalResult.scan.knowledge.map((entry) =>
          attachEnrichment(entry, generalResult.enrichments)
        ),
      };

      // Validate scan results
      if (!result || typeof result !== 'object') {
        console.error('Error: Invalid scan result');
        db.close();
        process.exit(1);
      }

      if (!options.quiet) {
        const sourceCodeCount = result.knowledge.filter((k) => k.type === 'source-code').length;
        const knowledgeCount = result.knowledge.length - sourceCodeCount;
        console.log(`Found:`);
        console.log(`  - ${knowledgeCount} knowledge entries`);
        console.log(`  - ${sourceCodeCount} source code files`);
        if (generalResult.stats.enrichedFiles > 0) {
          console.log(`  Enriched ${generalResult.stats.enrichedFiles} files via LSP`);
        }
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
        console.error('Error: Failed to index content');
        if (error instanceof Error) {
          console.error(`  ${error.message}`);
          if (error.message.includes('UNIQUE constraint')) {
            console.error('  This suggests duplicate entries in your content directory');
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
          summary: `Indexed ${result.knowledge.length} knowledge entries`,
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
    console.log(`  Knowledge Entries: ${stats.knowledge_entries}`);
    console.log(`  Events: ${stats.events}`);
    console.log();

    db.close();
  });

// Add search command
addSearchCommand(program);

// Add hooks command
addHooksCommand(program);

// Add migration commands
addMigrateCommands(program);

// Add lint command
addLintCommand(program);

// Add expert commands
addExpertCommands(program);

// Add ask command
addAskCommand(program);

program.parse();
