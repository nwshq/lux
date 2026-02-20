import type { LintFile, LintResult, LintRule } from '../../types.js';

/**
 * Validates that explorations are in valid locations.
 *
 * Valid (cross-cutting):
 *   explorations/2026-02-15-methodology.md
 *
 * Valid (project-scoped):
 *   knowledge/10_clients/nwshq/projects/workstream/explorations/2026-02-15-feature.md
 *
 * Invalid:
 *   some/random/path/explorations/2026-02-15-idea.md
 */

// Cross-cutting: directly under explorations/ at CORPUS root
const CROSS_CUTTING_PATTERN = /^explorations\/[^/]+\.md$/;

// Project-scoped: under knowledge/.../projects/<name>/explorations/
const PROJECT_SCOPED_PATTERN = /^knowledge\/.*\/projects\/[^/]+\/explorations\/[^/]+\.md$/;

function isExplorationFile(relativePath: string): boolean {
  return relativePath.includes('/explorations/') || relativePath.startsWith('explorations/');
}

export const explorationLocation: LintRule = {
  name: 'exploration-location',
  description:
    'Explorations must be cross-cutting (explorations/) or project-scoped (knowledge/.../projects/<name>/explorations/)',
  severity: 'error',

  check(file: LintFile, _corpusPath: string): LintResult[] {
    if (file.isDirectory) return [];
    if (!file.path.endsWith('.md')) return [];
    if (!isExplorationFile(file.relativePath)) return [];

    // Check if it matches either valid pattern
    if (CROSS_CUTTING_PATTERN.test(file.relativePath)) {
      return [];
    }
    if (PROJECT_SCOPED_PATTERN.test(file.relativePath)) {
      return [];
    }

    const filename = file.relativePath.split('/').pop();

    return [
      {
        path: file.path,
        rule: this.name,
        severity: this.severity,
        message: `Exploration "${filename}" is not in a valid location`,
        suggestion:
          'Move to explorations/ (cross-cutting) or knowledge/.../projects/<name>/explorations/ (project-scoped)',
      },
    ];
  },
};
