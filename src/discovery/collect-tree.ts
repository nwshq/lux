import { readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import type { TreeOptions } from './types.js';

// ── Defaults ──────────────────────────────────────────────

/** Default max depth for discovery (deeper than init's 5). */
export const DISCOVERY_TREE_DEPTH = 8;

/** Default max entries for discovery (more than init's 200). */
export const DISCOVERY_TREE_ENTRIES = 500;

/** Directories to skip during tree collection. */
export const IGNORE_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'vendor',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.cache',
  '.venv',
  'venv',
  'target',
]);

// ── Public API ────────────────────────────────────────────

/**
 * Collect a directory tree for discovery analysis.
 *
 * Produces a tree-formatted string showing directory structure,
 * with configurable depth and entry limits. Higher defaults than
 * the init module to give the AI more context for expert boundary
 * proposals.
 */
export function collectTree(rootPath: string, options?: TreeOptions): string {
  const maxDepth = options?.maxDepth ?? DISCOVERY_TREE_DEPTH;
  const maxEntries = options?.maxEntries ?? DISCOVERY_TREE_ENTRIES;

  const lines: string[] = [];
  let entryCount = 0;

  function walk(dir: string, depth: number, prefix: string): void {
    if (depth > maxDepth || entryCount >= maxEntries) return;

    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }

    // Filter out ignored directories and hidden files
    entries = entries.filter((e) => {
      if (e.startsWith('.')) return false;
      if (IGNORE_DIRS.has(e)) return false;
      return true;
    });

    for (let i = 0; i < entries.length; i++) {
      if (entryCount >= maxEntries) {
        lines.push(`${prefix}... (truncated)`);
        return;
      }

      const entry = entries[i];
      const fullPath = join(dir, entry);
      const isLast = i === entries.length - 1;
      const connector = isLast ? '\u2514\u2500\u2500 ' : '\u251c\u2500\u2500 ';
      const childPrefix = isLast ? '    ' : '\u2502   ';

      let isDir = false;
      try {
        isDir = statSync(fullPath).isDirectory();
      } catch {
        continue;
      }

      const displayName = isDir ? `${entry}/` : entry;
      lines.push(`${prefix}${connector}${displayName}`);
      entryCount++;

      if (isDir) {
        walk(fullPath, depth + 1, prefix + childPrefix);
      }
    }
  }

  lines.push(`${basename(rootPath)}/`);
  entryCount++;
  walk(rootPath, 1, '');

  return lines.join('\n');
}
