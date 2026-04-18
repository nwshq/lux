import { join, extname, basename } from 'path';
import { readFileSync } from 'fs';
import matter from 'gray-matter';
import type { ScannedKnowledge, Frontmatter } from './types.js';
import type { GitDiffResult } from './git.js';
import {
  SOURCE_CODE_EXTENSIONS,
  SOURCE_CODE_IGNORE_PATTERNS,
  detectLanguage,
  inferTagsFromPath,
} from './general.js';

export interface IncrementalPlan {
  toDelete: string[]; // Absolute file paths to remove from index
  toIndex: ScannedKnowledge[]; // New/modified entries to add
  unchanged: number; // Count of files not affected
}

/** Relative source-code paths whose changes can invalidate the structural overlay. */
export function collectOverlayRelevantPaths(diff: GitDiffResult): string[] {
  const allChanged = [...diff.added, ...diff.modified, ...diff.deleted];
  return allChanged.filter((filePath) => {
    const ext = extname(filePath);
    return SOURCE_CODE_EXTENSIONS.includes(ext) && !isExcludedPath(filePath);
  });
}

/** Whether a diff contains source changes that require canonical overlay rebuild. */
export function hasOverlayRelevantChanges(diff: GitDiffResult): boolean {
  return collectOverlayRelevantPaths(diff).length > 0;
}

/** Set of indexable extensions (markdown + source code). */
const INDEXABLE_EXTENSIONS = new Set(['.md', ...SOURCE_CODE_EXTENSIONS]);

/**
 * Check whether a relative file path should be excluded based on ignore patterns.
 * Matches against SOURCE_CODE_IGNORE_PATTERNS using simple prefix/glob logic.
 */
function isExcludedPath(relativePath: string): boolean {
  const segments = relativePath.split('/');

  for (const pattern of SOURCE_CODE_IGNORE_PATTERNS) {
    // Handle directory-based patterns like 'node_modules/**'
    if (pattern.endsWith('/**')) {
      const dir = pattern.slice(0, -3);
      if (segments.includes(dir)) return true;
    }
    // Handle glob patterns like '**/*.min.js'
    if (pattern.startsWith('**/')) {
      const suffix = pattern.slice(3);
      if (relativePath.endsWith(suffix)) return true;
    }
  }

  return false;
}

/**
 * Check whether a file is indexable (markdown or recognized source code).
 */
function isIndexableFile(relativePath: string): boolean {
  const ext = extname(relativePath);
  if (!INDEXABLE_EXTENSIONS.has(ext)) return false;
  if (isExcludedPath(relativePath)) return false;
  return true;
}

/**
 * Build a ScannedKnowledge entry for a file, using the same logic as GeneralScanner.
 */
function buildEntry(rootPath: string, relativePath: string): ScannedKnowledge | null {
  const filePath = join(rootPath, relativePath);
  const ext = extname(relativePath);

  if (ext === '.md') {
    // Markdown file — parse frontmatter
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = matter(raw);
      const frontmatter = parsed.data as Frontmatter;

      return {
        type: inferMarkdownType(relativePath, frontmatter),
        title: frontmatter?.title ?? frontmatter?.name ?? extractTitleFromFilename(relativePath),
        filePath,
        tags: frontmatter?.tags,
        frontmatter,
        content: parsed.content,
      };
    } catch {
      return null; // Skip unreadable files
    }
  } else {
    // Source code file
    const language = detectLanguage(ext);

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return null; // Skip unreadable files
    }

    return {
      type: 'source-code',
      title: relativePath,
      filePath,
      tags: inferTagsFromPath(relativePath),
      frontmatter: { language, extension: ext },
      content,
    };
  }
}

/**
 * Infer knowledge type from a markdown file path (mirrors GeneralScanner logic).
 */
function inferMarkdownType(filePath: string, frontmatter?: Frontmatter): string {
  if (frontmatter?.type) return String(frontmatter.type);

  if (filePath.includes('methodology')) return 'methodology';
  if (filePath.includes('specs')) return 'spec';
  if (filePath.includes('architecture')) return 'architecture';
  if (filePath.includes('explorations')) return 'exploration';
  if (filePath.includes('implementation-payloads')) return 'implementation-payload';
  if (filePath.includes('payloads')) return 'payload';

  return 'general';
}

/**
 * Extract a human-readable title from a markdown filename.
 */
function extractTitleFromFilename(filename: string): string {
  const base = basename(filename, '.md');
  const withoutDate = base.replace(/^\d{4}-\d{2}-\d{2}_/, '');
  return withoutDate
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Build an incremental index plan from a git diff.
 *
 * Filters diff results to only indexable files (markdown + source code),
 * then builds ScannedKnowledge entries for new/modified files.
 *
 * Modified files appear in both toDelete (remove old) and toIndex (add new)
 * to keep FTS5 consistent.
 */
export function buildIncrementalPlan(rootPath: string, diff: GitDiffResult): IncrementalPlan {
  const toDelete: string[] = [];
  const toIndex: ScannedKnowledge[] = [];
  let excluded = 0;

  // Process deleted files
  for (const file of diff.deleted) {
    if (isIndexableFile(file)) {
      toDelete.push(join(rootPath, file));
    } else {
      excluded++;
    }
  }

  // Process modified files — delete old, then re-index
  for (const file of diff.modified) {
    if (!isIndexableFile(file)) {
      excluded++;
      continue;
    }
    toDelete.push(join(rootPath, file));
    const entry = buildEntry(rootPath, file);
    if (entry) {
      toIndex.push(entry);
    }
  }

  // Process added files
  for (const file of diff.added) {
    if (!isIndexableFile(file)) {
      excluded++;
      continue;
    }
    const entry = buildEntry(rootPath, file);
    if (entry) {
      toIndex.push(entry);
    }
  }

  return {
    toDelete,
    toIndex,
    unchanged: excluded,
  };
}
