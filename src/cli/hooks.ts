import { Command } from 'commander';
import { copyFileSync, chmodSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function addHooksCommand(program: Command) {
  const hooksCmd = program.command('hooks').description('Manage git hooks');

  hooksCmd
    .command('install')
    .description('Install post-commit hook for CORPUS git repository')
    .option('--corpus <path>', 'CORPUS directory path (default: from --corpus global option)')
    .action((options: { corpus?: string }) => {
      const opts = program.opts();
      const corpusPath = options.corpus || (opts.corpus as string);

      const gitDir = join(corpusPath, '.git');
      if (!existsSync(gitDir)) {
        console.error(`Not a git repository: ${corpusPath}`);
        process.exit(1);
      }

      const hooksDir = join(gitDir, 'hooks');
      const postCommitPath = join(hooksDir, 'post-commit');

      // Find the hook script
      const hookScriptPath = join(__dirname, '../../bin/post-commit-hook.sh');

      if (!existsSync(hookScriptPath)) {
        console.error(`Hook script not found: ${hookScriptPath}`);
        console.error('Make sure lux is properly installed.');
        process.exit(1);
      }

      // Check if hook already exists
      if (existsSync(postCommitPath)) {
        const existing = readFileSync(postCommitPath, 'utf-8');
        if (existing.includes('Lux Knowledge Platform')) {
          console.log('✓ Lux post-commit hook already installed');
          return;
        }

        console.error('Warning: post-commit hook already exists.');
        console.error('Backup your existing hook before continuing.');
        console.error(`Path: ${postCommitPath}`);
        process.exit(1);
      }

      // Copy and make executable
      copyFileSync(hookScriptPath, postCommitPath);
      chmodSync(postCommitPath, 0o755);

      console.log('✓ Post-commit hook installed successfully');
      console.log(`  Path: ${postCommitPath}`);
      console.log('  The index will now rebuild automatically after each commit.');
    });

  hooksCmd
    .command('uninstall')
    .description('Uninstall post-commit hook')
    .option('--corpus <path>', 'CORPUS directory path (default: from --corpus global option)')
    .action((options: { corpus?: string }) => {
      const opts = program.opts();
      const corpusPath = options.corpus || (opts.corpus as string);

      const gitDir = join(corpusPath, '.git');
      if (!existsSync(gitDir)) {
        console.error(`Not a git repository: ${corpusPath}`);
        process.exit(1);
      }

      const postCommitPath = join(gitDir, 'hooks', 'post-commit');

      if (!existsSync(postCommitPath)) {
        console.log('No post-commit hook found');
        return;
      }

      const existing = readFileSync(postCommitPath, 'utf-8');
      if (!existing.includes('Lux Knowledge Platform')) {
        console.error('Warning: post-commit hook exists but is not a Lux hook.');
        console.error('Refusing to uninstall.');
        process.exit(1);
      }

      // Remove hook
      unlinkSync(postCommitPath);

      console.log('✓ Post-commit hook uninstalled');
    });
}
