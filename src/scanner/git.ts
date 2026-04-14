import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

export interface GitDiffResult {
  added: string[]; // New files
  modified: string[]; // Changed files
  deleted: string[]; // Removed files
}

/**
 * Check if a directory is a git repository.
 */
export function isGitRepository(rootPath: string): boolean {
  return existsSync(join(rootPath, '.git'));
}

/**
 * Get the current HEAD commit hash.
 */
export function getHeadCommit(rootPath: string): string {
  return execSync('git rev-parse HEAD', { cwd: rootPath, encoding: 'utf-8' }).trim();
}

/**
 * Get the diff between two commits, filtered to relevant files.
 *
 * Uses --diff-filter=ACDMR:
 *   A = Added, C = Copied, D = Deleted, M = Modified, R = Renamed
 *
 * Returns categorized file paths (relative to rootPath).
 */
export function getGitDiff(
  rootPath: string,
  fromCommit: string,
  toCommit: string = 'HEAD'
): GitDiffResult {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  // Get added files
  const addedOutput = execSync(`git diff --name-only --diff-filter=A ${fromCommit} ${toCommit}`, {
    cwd: rootPath,
    encoding: 'utf-8',
  }).trim();
  if (addedOutput) added.push(...addedOutput.split('\n'));

  // Get modified files (includes copied and renamed)
  const modifiedOutput = execSync(
    `git diff --name-only --diff-filter=CMR ${fromCommit} ${toCommit}`,
    { cwd: rootPath, encoding: 'utf-8' }
  ).trim();
  if (modifiedOutput) modified.push(...modifiedOutput.split('\n'));

  // Get deleted files
  const deletedOutput = execSync(`git diff --name-only --diff-filter=D ${fromCommit} ${toCommit}`, {
    cwd: rootPath,
    encoding: 'utf-8',
  }).trim();
  if (deletedOutput) deleted.push(...deletedOutput.split('\n'));

  return { added, modified, deleted };
}

/**
 * Check if a commit hash exists in the repository.
 */
export function commitExists(rootPath: string, commitHash: string): boolean {
  try {
    execSync(`git cat-file -t ${commitHash}`, { cwd: rootPath, encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the list of dirty (unstaged or staged but uncommitted) file paths
 * relative to the repository root.
 *
 * Uses `git status --porcelain` to detect any modified, added, deleted,
 * or renamed files in the working tree and index.
 */
export function getDirtyFiles(rootPath: string): string[] {
  try {
    const output = execSync('git status --porcelain', {
      cwd: rootPath,
      encoding: 'utf-8',
    }).trim();

    if (!output) return [];

    return output
      .split('\n')
      .map((line) => {
        // porcelain format: XY PATH or XY ORIG -> PATH
        const raw = line.slice(3);
        // Handle renames: "ORIG -> PATH" — take the target
        const arrowIdx = raw.indexOf(' -> ');
        return arrowIdx !== -1 ? raw.slice(arrowIdx + 4).trim() : raw.trim();
      })
      .filter((p) => p.length > 0);
  } catch {
    return [];
  }
}
