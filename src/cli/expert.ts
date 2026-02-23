import { Command } from 'commander';
import { existsSync } from 'fs';
import { join, resolve, isAbsolute, relative } from 'path';
import { LuxDatabase } from '../db/index.js';

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
  const expertCmd = program.command('expert').description('Manage expert panel');

  expertCmd
    .command('list')
    .description('List all registered experts')
    .option('--status <status>', 'Filter by status (active|inactive|all)', 'all')
    .option('--json', 'Output as JSON')
    .action((options: { status: string; json?: boolean }) => {
      const opts = program.opts();
      const db = new LuxDatabase(opts.db as string);

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
      const db = new LuxDatabase(opts.db as string);

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
    .option('--model <model>', 'Model to use', 'claude-sonnet-4-20250514')
    .action((slug: string, options: { mount: string; name?: string; model: string }) => {
      const opts = program.opts();
      const corpusPath = opts.corpus as string;
      const db = new LuxDatabase(opts.db as string);

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
        claude_md_path: detectedClaudeMd,
        memory_path: detectedMemory,
      });

      console.log(`Expert registered: ${slug}`);
      console.log(`  Name: ${expertName}`);
      console.log(`  Mount: ${mountPath}`);
      console.log(`  Model: ${options.model}`);
      if (detectedClaudeMd) {
        console.log(`  Claude MD: ${detectedClaudeMd} (auto-detected)`);
      }
      if (detectedMemory) {
        console.log(`  Memory: ${detectedMemory} (auto-detected)`);
      }

      db.close();
    });

  expertCmd
    .command('remove <slug>')
    .description('Unregister an expert')
    .option('--yes', 'Skip confirmation prompt')
    .action((slug: string, options: { yes?: boolean }) => {
      const opts = program.opts();
      const db = new LuxDatabase(opts.db as string);

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
}
