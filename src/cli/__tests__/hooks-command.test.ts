import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = join(PROJECT_ROOT, 'src', 'cli', 'index.ts');
const TSX_LOADER = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

function git(repoPath: string, command: string): string {
  return execSync(command, {
    cwd: repoPath,
    stdio: 'pipe',
    encoding: 'utf-8',
  }).trim();
}

function runCli(cwd: string, args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, ...args], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  });
}

describe('hooks command runtime path resolution', () => {
  let repoDir: string;
  let outsideDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-hooks-repo-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'lux-hooks-outside-'));

    mkdirSync(join(repoDir, '.lux'), { recursive: true });
    git(repoDir, 'git init');
    git(repoDir, 'git config user.email "test@test.com"');
    git(repoDir, 'git config user.name "Test"');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('uses cwd as corpus root when no --corpus is provided', () => {
    const result = runCli(repoDir, ['hooks', 'install']);
    const hookPath = join(repoDir, '.git', 'hooks', 'post-commit');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Post-commit hook installed successfully');
    expect(readFileSync(hookPath, 'utf-8')).toContain('Lux Knowledge Platform');
  });

  it('uses LUX_CORPUS_PATH when invoked outside the repo', () => {
    const result = runCli(outsideDir, ['hooks', 'install'], { LUX_CORPUS_PATH: repoDir });
    const hookPath = join(repoDir, '.git', 'hooks', 'post-commit');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Post-commit hook installed successfully');
    expect(readFileSync(hookPath, 'utf-8')).toContain('Lux Knowledge Platform');
  });

  it('still prefers explicit --corpus over env and cwd', () => {
    const otherRepoDir = mkdtempSync(join(tmpdir(), 'lux-hooks-other-repo-'));

    try {
      mkdirSync(join(otherRepoDir, '.lux'), { recursive: true });
      git(otherRepoDir, 'git init');
      git(otherRepoDir, 'git config user.email "test@test.com"');
      git(otherRepoDir, 'git config user.name "Test"');

      const result = runCli(outsideDir, ['hooks', 'install', '--corpus', otherRepoDir], {
        LUX_CORPUS_PATH: repoDir,
      });
      const hookPath = join(otherRepoDir, '.git', 'hooks', 'post-commit');

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Path: ${hookPath}`);
      expect(readFileSync(hookPath, 'utf-8')).toContain('Lux Knowledge Platform');
      expect(join(repoDir, '.git', 'hooks', 'post-commit')).not.toBe(hookPath);
    } finally {
      rmSync(otherRepoDir, { recursive: true, force: true });
    }
  });
});
