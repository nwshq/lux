import { basename } from 'path';
import type { LintFile, LintResult, LintRule } from '../../types.js';

/**
 * Validates that payload directory names match the YYYY-MM-DD-[slug]/ pattern.
 *
 * Valid:   2026-02-12-knowledge-platform/
 * Invalid: knowledge-platform/, 2026_02_12-platform/, 2026-02-12/
 */

const PAYLOAD_DIRNAME_PATTERN = /^\d{4}-\d{2}-\d{2}-.+$/;

const PAYLOAD_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;

function isValidDate(year: number, month: number, day: number): boolean {
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

function isPayloadDir(relativePath: string): boolean {
  // Match directories that are direct children of a payloads/ directory.
  // relativePath looks like "payloads/2026-02-12-slug" or
  // "knowledge/10_clients/acme/web-app/payloads/2026-02-12-slug"
  const parts = relativePath.replace(/\/$/, '').split('/');
  return parts.length >= 2 && parts[parts.length - 2] === 'payloads';
}

export const validPayloadDirname: LintRule = {
  name: 'valid-payload-dirname',
  description: 'Payload directory names must match YYYY-MM-DD-[slug]/ pattern',
  severity: 'error',

  check(file: LintFile, _corpusPath: string): LintResult[] {
    // Only check directories that are direct children of a payloads/ directory
    if (!file.isDirectory) return [];
    if (!isPayloadDir(file.relativePath)) return [];

    const dirname = basename(file.path);

    if (!PAYLOAD_DIRNAME_PATTERN.test(dirname)) {
      const hasDatePrefix = /^\d{4}-\d{2}-\d{2}/.test(dirname);
      let suggestion: string;

      if (hasDatePrefix) {
        suggestion = 'Rename to match YYYY-MM-DD-[slug]/ (use hyphens, not underscores)';
      } else {
        const slug = dirname
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        const today = new Date().toISOString().slice(0, 10);
        suggestion = `Rename to ${today}-${slug}/`;
      }

      return [
        {
          path: file.path,
          rule: this.name,
          severity: this.severity,
          message: `Payload directory "${dirname}" does not match required pattern YYYY-MM-DD-[slug]/`,
          suggestion,
        },
      ];
    }

    // Validate that the date portion is a real date
    const dateMatch = dirname.match(PAYLOAD_DATE_PATTERN);
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
            message: `Payload directory "${dirname}" contains invalid date ${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`,
            suggestion: 'Use a valid calendar date in YYYY-MM-DD format',
          },
        ];
      }
    }

    return [];
  },
};
