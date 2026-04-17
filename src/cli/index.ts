#!/usr/bin/env node

import { Command } from 'commander';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { LuxDatabase } from '../db/index.js';
import { GeneralScanner } from '../scanner/index.js';
import { attachEnrichment } from '../scanner/general.js';
import { rebuildWithOverlay, rebuildContentOnly } from '../scanner/rebuild-orchestrator.js';
import type { RebuildResult } from '../scanner/rebuild-orchestrator.js';
import { isGitRepository, getHeadCommit, getGitDiff, commitExists } from '../scanner/git.js';
import { buildIncrementalPlan } from '../scanner/incremental.js';
import { addSearchCommand } from './search.js';
import { addHooksCommand } from './hooks.js';
import { addMigrateCommands } from './migrate.js';
import { addLintCommand } from './lint.js';
import { addExpertCommands } from './expert.js';
import { addAskCommand } from './ask.js';
import { addDepsCommand } from './deps.js';
import { addOverlayCommands } from './overlay.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const version: string = (
  JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8')) as {
    version: string;
  }
).version;

const program = new Command();

// Global options
const DEFAULT_DB_PATH = join(homedir(), '.lux', 'lux.db');
const DEFAULT_CORPUS_PATH = join(homedir(), 'CORPUS');

program
  .name('lux')
  .description('Lux Knowledge Platform - semantic search and knowledge retrieval')
  .version(version)
  .option('--db <path>', 'Database path', DEFAULT_DB_PATH)
  .option('--corpus <path>', 'Content root directory path', DEFAULT_CORPUS_PATH);

// Index commands
const indexCmd = program.command('index').description('Manage index');

indexCmd
  .command('rebuild')
  .description(
    'Rebuild index from content directory.\n' +
      '  Default: overlay-complete rebuild with structural overlay and trust summary.\n' +
      '  Use --content-only for a faster fallback that skips overlay materialization.'
  )
  .option('--quiet', 'Suppress output')
  .option(
    '--content-only',
    'Run a content-only rebuild: knowledge index only, no structural overlay.'
  )
  .action(async (options: { quiet?: boolean; contentOnly?: boolean }) => {
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

      let generalResult;
      let overlayResult: RebuildResult | undefined;

      if (options.contentOnly) {
        // Content-only path: scan + enrich, no structural overlay
        try {
          const { scanResult } = await rebuildContentOnly(corpusPath, {
            onProgress: options.quiet ? undefined : (msg) => console.log(`  ${msg}`),
          });
          generalResult = scanResult;
        } catch (error) {
          console.error('Error: Failed to scan content directory');
          console.error(`  ${error instanceof Error ? error.message : String(error)}`);
          db.close();
          process.exit(1);
        }
      } else {
        // Overlay-complete path: default rebuild mode
        try {
          const { result, scanResult } = await rebuildWithOverlay(db, corpusPath, {
            onProgress: options.quiet ? undefined : (msg) => console.log(`  ${msg}`),
          });
          overlayResult = result;
          generalResult = scanResult;
        } catch (error) {
          console.error('Error: Failed to run overlay-complete rebuild');
          console.error(`  ${error instanceof Error ? error.message : String(error)}`);
          db.close();
          process.exit(1);
        }
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
        if (generalResult.dependencies.length > 0) {
          console.log(`  Detected ${generalResult.dependencies.length} module dependencies`);
        }
        if (options.contentOnly) {
          console.log(`\nClearing existing index...`);
        }
      }

      if (options.contentOnly) {
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
      }

      // Write module dependencies
      if (generalResult.dependencies.length > 0) {
        try {
          db.clearModuleDependencies();
          for (const dep of generalResult.dependencies) {
            db.insertModuleDependency({
              source_module: dep.source_module,
              target_module: dep.target_module,
              reference_count: dep.reference_count,
              sample_files: JSON.stringify(dep.sample_files),
            });
          }
        } catch (error) {
          if (!options.quiet) {
            console.warn(
              `Warning: Failed to write module dependencies: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }

      // Log event with error handling
      try {
        db.insertEvent({
          source: 'cli',
          event_type: 'index_rebuild',
          summary: options.contentOnly
            ? `Content-only rebuild: ${result.knowledge.length} knowledge entries`
            : `Overlay-complete rebuild: ${result.knowledge.length} entries, mode=${overlayResult?.mode ?? 'unknown'}`,
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
        if (overlayResult) {
          printRebuildTrustSummary(overlayResult);
        } else {
          console.log('\nMode: content-only');
          console.log(
            '  (This is the fallback path. Run plain "lux index rebuild" for the canonical overlay-complete rebuild.)'
          );
        }
        console.log('\n✓ Index rebuilt successfully');
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
        try {
          const { result } = await rebuildWithOverlay(db, corpusPath, {
            onProgress: options.quiet ? undefined : (msg) => console.log(`  ${msg}`),
          });
          const headCommit = getHeadCommit(corpusPath);
          db.setIndexMetadata('last_indexed_commit', headCommit);

          if (!options.quiet) {
            printRebuildTrustSummary(result);
            console.log(
              `\n✓ Full rebuild complete (${result.surfaceCount} surfaces, commit ${headCommit.slice(0, 8)})`
            );
          }

          db.close();
          return;
        } catch (error) {
          console.error('Error: Failed to run full overlay rebuild');
          console.error(`  ${error instanceof Error ? error.message : String(error)}`);
          db.close();
          process.exit(1);
        }
      }

      // Verify stored commit still exists
      if (!commitExists(corpusPath, lastCommit)) {
        if (!options.quiet) {
          console.warn(
            'Warning: Stored commit no longer exists (possible force push), running full rebuild...'
          );
        }
        try {
          const { result } = await rebuildWithOverlay(db, corpusPath, {
            onProgress: options.quiet ? undefined : (msg) => console.log(`  ${msg}`),
          });
          const headCommit = getHeadCommit(corpusPath);
          db.setIndexMetadata('last_indexed_commit', headCommit);

          if (!options.quiet) {
            printRebuildTrustSummary(result);
            console.log(
              `\n✓ Full rebuild complete (${result.surfaceCount} surfaces, commit ${headCommit.slice(0, 8)})`
            );
          }

          db.close();
          return;
        } catch (error) {
          console.error('Error: Failed to run full overlay rebuild');
          console.error(`  ${error instanceof Error ? error.message : String(error)}`);
          db.close();
          process.exit(1);
        }
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
        try {
          const { result } = await rebuildWithOverlay(db, corpusPath, {
            onProgress: options.quiet ? undefined : (msg) => console.log(`  ${msg}`),
          });
          db.setIndexMetadata('last_indexed_commit', headCommit);
          if (!options.quiet) {
            printRebuildTrustSummary(result);
            console.log(`\n✓ Full rebuild complete (${result.surfaceCount} surfaces)`);
          }
          db.close();
          return;
        } catch (error) {
          console.error('Error: Failed to run full overlay rebuild');
          console.error(`  ${error instanceof Error ? error.message : String(error)}`);
          db.close();
          process.exit(1);
        }
      }

      // Build incremental plan
      const plan = buildIncrementalPlan(corpusPath, diff);

      if (!options.quiet) {
        console.log(
          `Changes: +${diff.added.length} added, ~${diff.modified.length} modified, -${diff.deleted.length} deleted`
        );
        console.log(
          `Indexable: ${plan.toIndex.length} to index, ${plan.toDelete.length} to delete`
        );
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
          const { EnricherRegistry } = await import('../scanner/lsp/index.js');
          const { PhpLspEnricher } = await import('../scanner/lsp/php.js');
          const config = loadLspConfig(corpusPath);

          if (config.lsp.enabled) {
            if (!options.quiet) {
              console.log(`Enriching ${sourceFilesToEnrich.length} source files via LSP...`);
            }

            // Build enricher registry from config (same as generalScan but targeted)
            const registry = new EnricherRegistry();
            const ENRICHER_FACTORIES: Record<
              string,
              (entry: (typeof config.lsp.enrichers)[0]) => InstanceType<typeof PhpLspEnricher>
            > = {
              php: (entry) =>
                new PhpLspEnricher({
                  serverCommand: entry.serverCommand,
                  serverArgs: entry.serverArgs,
                  maxConcurrency: entry.maxConcurrency,
                  requestTimeoutMs: entry.requestTimeoutMs,
                  initTimeoutMs: entry.initTimeoutMs,
                }),
            };

            for (const entry of config.lsp.enrichers) {
              if (entry.enabled === false) continue;
              const factory = ENRICHER_FACTORIES[entry.languageId];
              if (!factory) continue;
              try {
                registry.register(factory(entry));
              } catch {
                /* skip */
              }
            }

            // Initialize enrichers
            const workspaceRoot = config.lsp.workspaceRoot ?? corpusPath;
            for (const enricher of registry.getAll()) {
              try {
                await enricher.initialize(workspaceRoot);
              } catch {
                /* skip */
              }
            }

            // Enrich ONLY the changed files
            const path = await import('path');
            const enrichmentMap = new Map<
              string,
              import('../scanner/lsp/index.js').EnrichmentResult
            >();

            for (const filePath of sourceFilesToEnrich) {
              const ext = path.extname(filePath);
              const enricher = registry.getByExtension(ext);
              if (!enricher?.isReady) continue;
              try {
                const result = await enricher.enrich(filePath);
                if (result) enrichmentMap.set(filePath, result);
              } catch {
                /* skip individual file errors */
              }
            }

            // Shut down enrichers
            try {
              await registry.shutdownAll();
            } catch {
              /* ignore */
            }

            // Apply enrichments to changed files
            for (let i = 0; i < plan.toIndex.length; i++) {
              const entry = plan.toIndex[i];
              if (enrichmentMap.has(entry.filePath)) {
                plan.toIndex[i] = attachEnrichment(entry, enrichmentMap);
              }
            }

            if (!options.quiet && enrichmentMap.size > 0) {
              console.log(`  Enriched ${enrichmentMap.size} files via LSP`);
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
        console.log(
          `✓ Synced: +${plan.toIndex.length} indexed, -${plan.toDelete.length} deleted (commit ${headCommit.slice(0, 8)})`
        );
      }

      db.close();
    } catch (error) {
      console.error('Error: Unexpected error during index sync');
      console.error(`  ${error instanceof Error ? error.message : String(error)}`);
      if (db) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
      process.exit(1);
    }
  });

indexCmd
  .command('status')
  .description('Show index statistics and overlay state')
  .action(() => {
    const opts = program.opts();
    const db = new LuxDatabase(opts.db as string);
    const stats = db.getStats();

    console.log('\nIndex Statistics:\n');
    console.log(`  Knowledge Entries: ${stats.knowledge_entries}`);
    console.log(`  Events: ${stats.events}`);

    const surfaces = db.getCapabilitySurfaces();
    const fileNodes = db.getStructuralNodesByType('file');
    const symbolNodes = db.getStructuralNodesByType('symbol');

    console.log('\nStructural Overlay:');
    if (surfaces.length === 0 && fileNodes.length === 0) {
      console.log('  No overlay — run "lux index rebuild" to build the canonical overlay path.');
    } else {
      const overlayMode =
        symbolNodes.length === 0 && surfaces.length > 0 ? 'degraded-overlay' : 'overlay-present';
      console.log(`  Mode: ${overlayMode}`);
      console.log(`  Surfaces: ${surfaces.length}`);
      console.log(`  Nodes: ${fileNodes.length} files, ${symbolNodes.length} symbols`);
    }
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

// Add deps command
addDepsCommand(program);

// Add overlay commands
addOverlayCommands(program);

program.parse();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printRebuildTrustSummary(r: RebuildResult): void {
  console.log(`\nMode: ${r.mode}`);

  if (r.mode === 'overlay-complete' || r.mode === 'degraded-overlay') {
    console.log(`Surfaces: ${r.surfaceCount}`);
    if (r.surfaceCount > 0) {
      console.log(
        `Provider kinds: ${r.controllerBackedCount} controller-backed, ` +
          `${r.closureBackedCount} closure-backed, ${r.unknownProviderKindCount} unknown`
      );
    }
    console.log(`Nodes: ${r.fileNodeCount} files, ${r.symbolNodeCount} symbols`);
    console.log(`Edges: ${r.detectorEdgeCount} detector, ${r.propagatedEdgeCount} propagated`);
    console.log(
      `Enrichments: ${
        r.enrichmentStatus === 'active'
          ? 'loaded from repo config'
          : r.configLspEnabled
            ? 'configured but unavailable'
            : 'inactive'
      }`
    );
  }

  for (const warning of r.warnings) {
    console.warn(`Warning: ${warning}`);
  }
}
