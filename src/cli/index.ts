#!/usr/bin/env node

import { Command } from 'commander';
import { join } from 'path';
import { homedir } from 'os';
import { LuxDatabase } from '../db/index.js';
import { GeneralScanner } from '../scanner/index.js';
import { generalScan, attachEnrichment } from '../scanner/general.js';
import { isGitRepository, getHeadCommit, getGitDiff, commitExists } from '../scanner/git.js';
import { buildIncrementalPlan } from '../scanner/incremental.js';
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

      // Store HEAD commit hash if this is a git repo
      if (isGitRepository(corpusPath)) {
        try {
          const headCommit = getHeadCommit(corpusPath);
          db.setIndexMetadata('last_indexed_commit', headCommit);
          if (!options.quiet) {
            console.log(`Stored commit hash: ${headCommit.slice(0, 8)}`);
          }
        } catch {
          if (!options.quiet) {
            console.warn('Warning: Failed to store git commit hash');
          }
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
  .command('sync')
  .description('Incrementally update index based on git changes')
  .option('--quiet', 'Suppress output')
  .option('--force', 'Ignore stored commit, do full rebuild')
  .action(async (options: { quiet?: boolean; force?: boolean }) => {
    const opts = program.opts();
    const corpusPath = opts.corpus as string;
    let db: LuxDatabase | undefined;

    try {
      // Validate content directory
      if (!existsSync(corpusPath)) {
        console.error(`Error: Content directory not found: ${corpusPath}`);
        process.exit(1);
      }

      // Check if this is a git repo
      if (!isGitRepository(corpusPath)) {
        console.error('Error: Content directory is not a git repository');
        console.error('  Use "lux index rebuild" for non-git directories');
        process.exit(1);
      }

      // Initialize database
      try {
        db = new LuxDatabase(opts.db as string);
      } catch (error) {
        console.error(`Error: Failed to initialize database: ${opts.db}`);
        console.error(`  ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }

      if (!db.isSchemaUpToDate()) {
        console.error('Error: Database schema is not up to date');
        console.error('  Run "lux migrate" to update the schema');
        db.close();
        process.exit(1);
      }

      const lastCommit = db.getIndexMetadata('last_indexed_commit');

      // If --force or no stored commit, fall back to full rebuild
      if (options.force || !lastCommit) {
        if (!options.quiet) {
          if (options.force) {
            console.log('Force flag set, running full rebuild...');
          } else {
            console.log('No previous index commit found, running full rebuild...');
          }
        }
        // Delegate to the rebuild logic by re-executing it programmatically
        // We replicate the rebuild flow here for simplicity
        const scanner = new GeneralScanner(corpusPath);
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

        const result = {
          ...generalResult.scan,
          knowledge: generalResult.scan.knowledge.map((entry) =>
            attachEnrichment(entry, generalResult.enrichments)
          ),
        };

        db.clearAll();
        await scanner.index(db, result);

        const headCommit = getHeadCommit(corpusPath);
        db.setIndexMetadata('last_indexed_commit', headCommit);

        if (!options.quiet) {
          console.log(`✓ Full rebuild complete (${result.knowledge.length} entries, commit ${headCommit.slice(0, 8)})`);
        }

        db.close();
        return;
      }

      // Verify stored commit still exists
      if (!commitExists(corpusPath, lastCommit)) {
        if (!options.quiet) {
          console.warn('Warning: Stored commit no longer exists (possible force push), running full rebuild...');
        }
        const scanner = new GeneralScanner(corpusPath);
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

        const result = {
          ...generalResult.scan,
          knowledge: generalResult.scan.knowledge.map((entry) =>
            attachEnrichment(entry, generalResult.enrichments)
          ),
        };

        db.clearAll();
        await scanner.index(db, result);

        const headCommit = getHeadCommit(corpusPath);
        db.setIndexMetadata('last_indexed_commit', headCommit);

        if (!options.quiet) {
          console.log(`✓ Full rebuild complete (${result.knowledge.length} entries, commit ${headCommit.slice(0, 8)})`);
        }

        db.close();
        return;
      }

      // Get HEAD commit
      const headCommit = getHeadCommit(corpusPath);

      // Check if already up to date
      if (headCommit === lastCommit) {
        if (!options.quiet) {
          console.log('Index is up to date');
        }
        db.close();
        return;
      }

      if (!options.quiet) {
        console.log(`Syncing index: ${lastCommit.slice(0, 8)}..${headCommit.slice(0, 8)}`);
      }

      // Get git diff
      let diff;
      try {
        diff = getGitDiff(corpusPath, lastCommit, headCommit);
      } catch {
        if (!options.quiet) {
          console.warn('Warning: git diff failed, running full rebuild...');
        }
        const scanner = new GeneralScanner(corpusPath);
        const generalResult = await generalScan(corpusPath, {
          onProgress: options.quiet ? undefined : (msg) => console.log(`  ${msg}`),
        });
        const result = {
          ...generalResult.scan,
          knowledge: generalResult.scan.knowledge.map((entry) =>
            attachEnrichment(entry, generalResult.enrichments)
          ),
        };
        db.clearAll();
        await scanner.index(db, result);
        db.setIndexMetadata('last_indexed_commit', headCommit);
        if (!options.quiet) {
          console.log(`✓ Full rebuild complete (${result.knowledge.length} entries)`);
        }
        db.close();
        return;
      }

      // Build incremental plan
      const plan = buildIncrementalPlan(corpusPath, diff);

      if (!options.quiet) {
        console.log(`Changes: +${diff.added.length} added, ~${diff.modified.length} modified, -${diff.deleted.length} deleted`);
        console.log(`Indexable: ${plan.toIndex.length} to index, ${plan.toDelete.length} to delete`);
      }

      // Delete removed entries from DB
      for (const filePath of plan.toDelete) {
        db.deleteKnowledgeEntryByPath(filePath);
      }

      // LSP enrichment for changed source files only
      const sourceFilesToEnrich = plan.toIndex
        .filter((entry) => entry.type === 'source-code')
        .map((entry) => entry.filePath);

      if (sourceFilesToEnrich.length > 0) {
        try {
          const { loadLspConfig } = await import('../scanner/config.js');
          const config = loadLspConfig(corpusPath);

          if (config.lsp.enabled) {
            if (!options.quiet) {
              console.log(`Enriching ${sourceFilesToEnrich.length} source files via LSP...`);
            }

            // Run enrichment on just the changed files by doing a targeted scan
            const targetedResult = await generalScan(corpusPath, {
              onProgress: options.quiet ? undefined : (msg) => console.log(`  ${msg}`),
            });

            // Apply enrichments only to our changed files
            for (let i = 0; i < plan.toIndex.length; i++) {
              const entry = plan.toIndex[i];
              const enrichment = targetedResult.enrichments.get(entry.filePath);
              if (enrichment) {
                plan.toIndex[i] = attachEnrichment(entry, targetedResult.enrichments);
              }
            }
          }
        } catch {
          if (!options.quiet) {
            console.warn('Warning: LSP enrichment failed, continuing without enrichment');
          }
        }
      }

      // Index new/modified entries
      for (const entry of plan.toIndex) {
        db.insertKnowledgeEntry({
          type: entry.type,
          title: entry.title,
          file_path: entry.filePath,
          tags: entry.tags,
          metadata: entry.frontmatter,
          content: entry.content,
        });
      }

      // Store new commit hash
      db.setIndexMetadata('last_indexed_commit', headCommit);

      // Log event
      try {
        db.insertEvent({
          source: 'cli',
          event_type: 'index_sync',
          summary: `Synced index: +${plan.toIndex.length} indexed, -${plan.toDelete.length} deleted`,
        });
      } catch {
        // Non-fatal
      }

      if (!options.quiet) {
        console.log(`✓ Synced: +${plan.toIndex.length} indexed, -${plan.toDelete.length} deleted (commit ${headCommit.slice(0, 8)})`);
      }

      db.close();
    } catch (error) {
      console.error('Error: Unexpected error during index sync');
      console.error(`  ${error instanceof Error ? error.message : String(error)}`);
      if (db) {
        try { db.close(); } catch { /* ignore */ }
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
