import { basename } from 'path';
import type { LintFile, LintResult, LintRule } from '../../types.js';

/**
 * Validates that exploration filenames match the `YYYY-MM-DD-*.md` pattern.
 *
 * Valid:   2026-02-11-knowledge-platform.md
 * Invalid: my-idea.md, knowledge-platform.md, 2026_02_11-idea.md
 */

const EXPLORATION_FILENAME_PATTERN = /^\d{4}-\d{2}-\d{2}-.+\.md$/;

const EXPLORATION_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;

function isValidDate(year: number, month: number, day: number): boolean {
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export const validExplorationFilename: LintRule = {
  name: 'valid-exploration-filename',
  description: 'Exploration filenames must match YYYY-MM-DD-<slug>.md pattern',
  severity: 'error',

  check(file: LintFile, _corpusPath: string): LintResult[] {
    // Only check files inside an explorations/ directory
    if (file.isDirectory) return [];
    if (!file.relativePath.includes('explorations/')) return [];

    const filename = basename(file.path);

    // Skip non-markdown files
    if (!filename.endsWith('.md')) return [];

    if (!EXPLORATION_FILENAME_PATTERN.test(filename)) {
      const hasDatePrefix = /^\d{4}-\d{2}-\d{2}/.test(filename);
      let suggestion: string;

      if (hasDatePrefix) {
        // Has date but wrong separator or missing slug
        suggestion = `Rename to match YYYY-MM-DD-<slug>.md (use hyphens, not underscores)`;
      } else {
        const slug = filename
          .replace(/\.md$/, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        const today = new Date().toISOString().slice(0, 10);
        suggestion = `Rename to ${today}-${slug}.md`;
      }

      return [
        {
          path: file.path,
          rule: this.name,
          severity: this.severity,
          message: `Exploration filename "${filename}" does not match required pattern YYYY-MM-DD-<slug>.md`,
          suggestion,
        },
      ];
    }

    // Validate that the date portion is a real date
    const dateMatch = filename.match(EXPLORATION_DATE_PATTERN);
    if (dateMatch) {
      const year = parseInt(dateMatch[1], 10);
      const month = parseInt(dateMatch[2], 10);
      const day = parseInt(dateMatch[3], 10);

      if (!isValidDate(year, month, day)) {
        return [
          {
            path: file.path,
            rule: this.name,
            severity: this.severity,
            message: `Exploration filename "${filename}" contains invalid date ${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`,
            suggestion: 'Use a valid calendar date in YYYY-MM-DD format',
          },
        ];
      }
    }

    return [];
  },
};
