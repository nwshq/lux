import { basename, join } from 'path';
import { existsSync } from 'fs';
import type { LintFile, LintResult, LintRule } from '../../types.js';

/**
 * Validates that every payload directory contains a TASKS.md file.
 *
 * Payload directories are direct children of a payloads/ directory
 * (e.g. payloads/2026-02-12-knowledge-platform/).
 */

function isPayloadDir(relativePath: string): boolean {
  const parts = relativePath.replace(/\/$/, '').split('/');
  return parts.length >= 2 && parts[parts.length - 2] === 'payloads';
}

export const payloadHasTasks: LintRule = {
  name: 'payload-has-tasks',
  description: 'Payload directories must contain a TASKS.md file',
  severity: 'error',

  check(file: LintFile, _corpusPath: string): LintResult[] {
    if (!file.isDirectory) return [];
    if (!isPayloadDir(file.relativePath)) return [];

    const tasksPath = join(file.path, 'TASKS.md');

    if (!existsSync(tasksPath)) {
      const dirname = basename(file.path);
      return [
        {
          path: file.path,
          rule: this.name,
          severity: this.severity,
          message: `Payload directory "${dirname}" is missing required TASKS.md`,
          suggestion: `Create ${dirname}/TASKS.md with a task breakdown for this payload`,
        },
      ];
    }

    return [];
  },
};
