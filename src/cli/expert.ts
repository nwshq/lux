import { Command } from 'commander';
import { existsSync } from 'fs';
import { join, resolve, isAbsolute, relative } from 'path';
import { LuxDatabase } from '../db/index.js';
import { resolveCorpusPath, resolveDbPath } from '../utils/runtime-paths.js';
import { runDiscoveryPipeline, createDefaultStages } from '../discovery/index.js';
import type {
  DiscoveryOptions,
  DiscoveryResult,
  ProposedExpert,
  DiffResult,
} from '../discovery/index.js';
import { resolveAiDefaults, resolveSynthesisDefaults } from '../utils/ai-defaults.js';

/**
 * Resolve and validate a mount path for expert registration.
 * Returns the resolved absolute path, or an error message string.
 *
 * Validation rules:
 * 1. The resolved path must be inside the content root directory.
 * 2. The resolved path must exist on disk.
 */
export function validateMountPath(
  mount: string,
  corpusPath: string
): { ok: true; path: string } | { ok: false; error: string } {
  const mountPath = isAbsolute(mount) ? mount : resolve(corpusPath, mount);
  const resolvedCorpus = resolve(corpusPath);
  const rel = relative(resolvedCorpus, mountPath);

  if (rel.startsWith('..') || isAbsolute(rel)) {
    return {
      ok: false,
      error: `Mount path must be inside content root: ${mountPath} is outside ${resolvedCorpus}`,
    };
  }

  if (!existsSync(mountPath)) {
    return { ok: false, error: `Mount path does not exist: ${mountPath}` };
  }

  return { ok: true, path: mountPath };
}

/**
 * Detect claude.md at a mount path. Checks both claude.md and CLAUDE.md.
 * Returns the full path if found, undefined otherwise.
 */
function detectClaudeMd(mountPath: string): string | undefined {
  const lowercase = join(mountPath, 'claude.md');
  if (existsSync(lowercase)) return lowercase;
  const uppercase = join(mountPath, 'CLAUDE.md');
  if (existsSync(uppercase)) return uppercase;
  return undefined;
}

export function addExpertCommands(program: Command) {
  const AI_DEFAULTS = resolveAiDefaults();
  const SYNTHESIS_DEFAULTS = resolveSynthesisDefaults();
  const expertCmd = program.command('expert').description('Manage expert panel');

  expertCmd
    .command('list')
    .description('List all registered experts')
    .option('--status <status>', 'Filter by status (active|inactive|all)', 'all')
    .option('--json', 'Output as JSON')
    .action((options: { status: string; json?: boolean }) => {
      const opts = program.opts();
      const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
      const db = new LuxDatabase(
        resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
      );

      let experts;
      if (options.status === 'all') {
        experts = db.getAllExperts();
      } else {
        experts = db.getExpertsByStatus(options.status);
      }

      if (options.json) {
        console.log(JSON.stringify(experts, null, 2));
        db.close();
        return;
      }

      if (experts.length === 0) {
        console.log('No experts found.');
        db.close();
        return;
      }

      console.log(`\nExperts (${experts.length}):\n`);
      for (const expert of experts) {
        console.log(`  ${expert.slug}`);
        console.log(`    Name: ${expert.name}`);
        console.log(`    Mount: ${expert.mount_path}`);
        console.log(`    Model: ${expert.model}`);
        console.log(`    Status: ${expert.status}`);
        const liveClaudeMd = detectClaudeMd(expert.mount_path);
        if (liveClaudeMd) {
          console.log(`    Claude MD: ${liveClaudeMd}`);
        } else if (expert.claude_md_path) {
          console.log(`    Claude MD: ${expert.claude_md_path} (missing)`);
        }
        if (expert.memory_path) {
          const exists = existsSync(expert.memory_path);
          console.log(`    Memory: ${expert.memory_path}${exists ? '' : ' (missing)'}`);
        }
        console.log();
      }

      db.close();
    });

  expertCmd
    .command('show <slug>')
    .description('Show expert details')
    .option('--json', 'Output as JSON')
    .action((slug: string, options: { json?: boolean }) => {
      const opts = program.opts();
      const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
      const db = new LuxDatabase(
        resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
      );

      const expert = db.getExpert(slug);
      if (!expert) {
        console.error(`Expert not found: ${slug}`);
        db.close();
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify(expert, null, 2));
        db.close();
        return;
      }

      console.log(`\nExpert: ${expert.name}`);
      console.log(`Slug: ${expert.slug}`);
      console.log(`Mount: ${expert.mount_path}`);
      console.log(`Model: ${expert.model}`);
      console.log(`Status: ${expert.status}`);

      const liveClaudeMd = detectClaudeMd(expert.mount_path);
      if (liveClaudeMd) {
        console.log(`Claude MD: ${liveClaudeMd}`);
      } else if (expert.claude_md_path) {
        console.log(`Claude MD: ${expert.claude_md_path} (missing)`);
      } else {
        console.log('Claude MD: none');
      }

      if (expert.memory_path) {
        const memoryExists = existsSync(expert.memory_path);
        console.log(`Memory: ${expert.memory_path}${memoryExists ? '' : ' (missing)'}`);
      } else {
        console.log('Memory: not configured');
      }

      db.close();
    });

  expertCmd
    .command('add <slug>')
    .description('Register a new expert')
    .requiredOption('--mount <path>', 'Mount path (relative to content root or absolute)')
    .option('--name <name>', 'Expert name (defaults to slug)')
    .option('--model <model>', 'Model to use', AI_DEFAULTS.model)
    .option('--backend <backend>', 'Execution backend (claude|pi)', AI_DEFAULTS.backend)
    .option(
      '--provider <provider>',
      'Provider for Pi-backed experts (for example openai)',
      AI_DEFAULTS.provider ?? 'openai'
    )
    .option(
      '--thinking <level>',
      'Pi thinking level (off|minimal|low|medium|high|xhigh)',
      AI_DEFAULTS.thinking ?? 'high'
    )
    .action(
      (
        slug: string,
        options: {
          mount: string;
          name?: string;
          model: string;
          backend: 'claude' | 'pi';
          provider?: string;
          thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
        }
      ) => {
        const opts = program.opts();
        const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
        const db = new LuxDatabase(
          resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
        );

        // Resolve and validate mount path
        const mountResult = validateMountPath(options.mount, corpusPath);
        if (!mountResult.ok) {
          console.error(mountResult.error);
          db.close();
          process.exit(1);
        }
        const mountPath = mountResult.path;

        // Check for duplicate slug
        const existing = db.getExpert(slug);
        if (existing) {
          console.error(`Expert already exists: ${slug}`);
          db.close();
          process.exit(1);
        }

        // Auto-detect claude.md (or CLAUDE.md) and memory.md
        const detectedClaudeMd = detectClaudeMd(mountPath);
        const memoryMdPath = join(mountPath, 'memory.md');
        const detectedMemory = existsSync(memoryMdPath) ? memoryMdPath : undefined;

        const expertName = options.name ?? slug;

        db.insertExpert({
          slug,
          name: expertName,
          mount_path: mountPath,
          model: options.model,
          backend: options.backend,
          provider: options.backend === 'pi' ? options.provider : undefined,
          thinking: options.backend === 'pi' ? options.thinking : undefined,
          claude_md_path: detectedClaudeMd,
          memory_path: detectedMemory,
        });

        console.log(`Expert registered: ${slug}`);
        console.log(`  Name: ${expertName}`);
        console.log(`  Mount: ${mountPath}`);
        console.log(`  Backend: ${options.backend}`);
        if (options.backend === 'pi' && options.provider) {
          console.log(`  Provider: ${options.provider}`);
        }
        if (options.backend === 'pi' && options.thinking) {
          console.log(`  Thinking: ${options.thinking}`);
        }
        console.log(`  Model: ${options.model}`);
        if (detectedClaudeMd) {
          console.log(`  Claude MD: ${detectedClaudeMd} (auto-detected)`);
        }
        if (detectedMemory) {
          console.log(`  Memory: ${detectedMemory} (auto-detected)`);
        }

        db.close();
      }
    );

  expertCmd
    .command('remove <slug>')
    .description('Unregister an expert')
    .option('--yes', 'Skip confirmation prompt')
    .action((slug: string, options: { yes?: boolean }) => {
      const opts = program.opts();
      const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
      const db = new LuxDatabase(
        resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
      );

      const expert = db.getExpert(slug);
      if (!expert) {
        console.error(`Expert not found: ${slug}`);
        db.close();
        process.exit(1);
      }

      if (!options.yes) {
        console.error(`Use --yes to confirm removal of expert: ${expert.name} (${expert.slug})`);
        db.close();
        process.exit(1);
      }

      // Clean up sessions first
      db.deleteSessionsByExpert(expert.id);
      db.deleteExpert(slug);

      console.log(`Expert removed: ${expert.name} (${expert.slug})`);
      db.close();
    });

  expertCmd
    .command('discover')
    .description('Discover and propose expert boundaries from directory structure')
    .option('--model <model>', 'AI model for analysis', AI_DEFAULTS.model)
    .option(
      '--provider <provider>',
      'Provider for Pi-backed analysis (for example openai)',
      AI_DEFAULTS.provider ?? 'openai'
    )
    .option('--backend <backend>', 'Analysis backend (claude|pi)', AI_DEFAULTS.backend)
    .option(
      '--synthesis-backend <backend>',
      'Optional synthesis backend override (claude|pi)',
      SYNTHESIS_DEFAULTS.backend
    )
    .option(
      '--synthesis-provider <provider>',
      'Optional provider override for Pi-backed synthesis',
      SYNTHESIS_DEFAULTS.provider
    )
    .option(
      '--synthesis-model <model>',
      'Optional synthesis model override',
      SYNTHESIS_DEFAULTS.model
    )
    .option(
      '--thinking <level>',
      'Pi thinking level (off|minimal|low|medium|high|xhigh)',
      AI_DEFAULTS.thinking
    )
    .option(
      '--analysis-timeout-ms <ms>',
      'Timeout per analysis subprocess in milliseconds',
      '180000'
    )
    .option('--dry-run', 'Show proposals without registering')
    .option('--accept-all', 'Accept all proposals without interactive review')
    .option('--diff', 'Only show proposals that differ from current experts')
    .option('--json', 'Output proposals as JSON (skip interactive review)')
    .option('--max-experts <n>', 'Maximum number of experts to propose', '20')
    .option('--min-confidence <f>', 'Minimum confidence threshold (0.0-1.0)', '0.5')
    .action(
      async (options: {
        model: string;
        provider?: string;
        backend: 'claude' | 'pi';
        synthesisBackend?: 'claude' | 'pi';
        synthesisProvider?: string;
        synthesisModel?: string;
        thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
        analysisTimeoutMs: string;
        dryRun?: boolean;
        acceptAll?: boolean;
        diff?: boolean;
        json?: boolean;
        maxExperts: string;
        minConfidence: string;
      }) => {
        const opts = program.opts();
        const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });

        if (!existsSync(corpusPath)) {
          console.error(`Content root not found: ${corpusPath}`);
          console.error('  Set --corpus <path> or ensure the directory exists.');
          process.exit(1);
        }

        const db = new LuxDatabase(
          resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
        );

        const discoveryOptions: DiscoveryOptions = {
          rootPath: corpusPath,
          model: options.model,
          provider: options.provider,
          backend: options.backend,
          synthesisBackend: options.synthesisBackend,
          synthesisProvider: options.synthesisProvider,
          synthesisModel: options.synthesisModel,
          thinking: options.thinking,
          analysisTimeoutMs: parseInt(options.analysisTimeoutMs, 10),
          dryRun: options.dryRun,
          acceptAll: options.acceptAll,
          diff: options.diff,
          json: options.json,
          maxExperts: parseInt(options.maxExperts, 10),
          minConfidence: parseFloat(options.minConfidence),
        };

        // Validate parsed numbers
        if (isNaN(discoveryOptions.maxExperts!)) {
          console.error('--max-experts must be a number');
          db.close();
          process.exit(1);
        }
        if (
          isNaN(discoveryOptions.minConfidence!) ||
          discoveryOptions.minConfidence! < 0 ||
          discoveryOptions.minConfidence! > 1
        ) {
          console.error('--min-confidence must be a number between 0.0 and 1.0');
          db.close();
          process.exit(1);
        }
        if (
          isNaN(discoveryOptions.analysisTimeoutMs!) ||
          discoveryOptions.analysisTimeoutMs! <= 0
        ) {
          console.error('--analysis-timeout-ms must be a positive number of milliseconds');
          db.close();
          process.exit(1);
        }

        const stages = createDefaultStages();

        try {
          const result = await runDiscoveryPipeline(db, discoveryOptions, stages);

          if (options.diff && result.diffResult) {
            if (options.json) {
              console.log(JSON.stringify(result.diffResult, null, 2));
            } else {
              formatDiffOutput(result.diffResult);
            }
          } else if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            formatDiscoveryOutput(result, options.dryRun);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (options.json) {
            console.log(JSON.stringify({ error: message }, null, 2));
          } else {
            console.error(`Discovery failed: ${message}`);
          }
          db.close();
          process.exit(1);
        }

        db.close();
      }
    );
}

// ── Discovery Output Formatting ────────────────────────────

export function formatDiscoveryOutput(result: DiscoveryResult, dryRun?: boolean): void {
  if (result.proposed.length === 0) {
    console.log(`\nNo expert proposals generated.`);
    if (result.rationale) {
      console.log(`  Reason: ${result.rationale}`);
    }
    return;
  }

  const mode = dryRun ? ' (dry run)' : '';
  console.log(`\nExpert Discovery Results${mode}\n`);

  if (result.rationale) {
    console.log(`Rationale: ${result.rationale}\n`);
  }

  // Proposals table
  formatProposalTable(result.proposed);

  // Summary
  if (result.accepted.length > 0) {
    console.log(`\nAccepted: ${result.accepted.length}`);
    for (const expert of result.accepted) {
      console.log(`  + ${expert.slug} (${expert.mountPath})`);
    }
  }

  if (result.skipped.length > 0) {
    console.log(`Skipped: ${result.skipped.length}`);
  }

  if (result.registered.length > 0) {
    console.log(`\nRegistered ${result.registered.length} expert(s):`);
    for (const reg of result.registered) {
      console.log(`  ${reg.slug} -> ${reg.mountPath}`);
      if (reg.claudeMdPath) {
        console.log(`    claude.md: ${reg.claudeMdPath}`);
      }
    }
  }
}

export function formatProposalTable(proposals: ProposedExpert[]): void {
  // Header
  const slugWidth = Math.max(4, ...proposals.map((p) => p.slug.length));
  const mountWidth = Math.max(10, ...proposals.map((p) => p.mountPath.length));

  console.log(
    `  ${'#'.padStart(3)}  ${'Slug'.padEnd(slugWidth)}  ${'Mount Path'.padEnd(mountWidth)}  Confidence`
  );
  console.log(
    `  ${'─'.repeat(3)}  ${'─'.repeat(slugWidth)}  ${'─'.repeat(mountWidth)}  ${'─'.repeat(10)}`
  );

  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    const num = String(i + 1).padStart(3);
    const conf = p.confidence.toFixed(2);
    console.log(
      `  ${num}  ${p.slug.padEnd(slugWidth)}  ${p.mountPath.padEnd(mountWidth)}  ${conf}`
    );
  }
}

function formatDiffOutput(diff: DiffResult): void {
  console.log(`\n${diff.summary}\n`);

  if (diff.staleExperts.length > 0) {
    console.log('Stale Experts:\n');
    for (const stale of diff.staleExperts) {
      console.log(`  ! ${stale.expert.slug} — ${stale.reason}`);
    }
    console.log();
  }

  if (diff.newProposals.length > 0) {
    console.log('New Expert Proposals:\n');
    formatProposalTable(diff.newProposals.map((c) => c.proposal));
    console.log();
  }

  if (diff.updatedProposals.length > 0) {
    console.log('Boundary Changes:\n');
    for (const classified of diff.updatedProposals) {
      const p = classified.proposal;
      console.log(`  ~ ${p.slug} (${p.confidence.toFixed(2)})`);
      console.log(`    ${classified.reason}`);
      console.log(`    Proposed mount: ${p.mountPath}`);
    }
    console.log();
  }

  if (diff.duplicates.length > 0) {
    console.log(`(${diff.duplicates.length} duplicate(s) filtered — already registered)\n`);
  }

  if (
    diff.newProposals.length === 0 &&
    diff.updatedProposals.length === 0 &&
    diff.staleExperts.length === 0
  ) {
    console.log('Expert panel is up to date. No action needed.');
  }
}
