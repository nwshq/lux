import type { LintFile, LintResult, LintRule } from '../../types.js';

/**
 * Detects explorations at the CORPUS root level (cross-cutting).
 *
 * Cross-cutting explorations are allowed but flagged as info so that
 * operators are aware of their presence.
 *
 * Detected:
 *   explorations/2026-02-15-methodology.md  → info
 *
 * Ignored (project-scoped — handled by exploration-location):
 *   knowledge/10_clients/nwshq/projects/workstream/explorations/2026-02-15-feature.md
 */

const CROSS_CUTTING_PATTERN = /^explorations\/[^/]+\.md$/;

export const explorationCorpusLocation: LintRule = {
  name: 'exploration-corpus-location',
  description: 'Detects cross-cutting explorations at the CORPUS root (allowed)',
  severity: 'info',

  check(file: LintFile, _corpusPath: string): LintResult[] {
    if (file.isDirectory) return [];
    if (!file.path.endsWith('.md')) return [];
    if (!CROSS_CUTTING_PATTERN.test(file.relativePath)) return [];

    const filename = file.relativePath.split('/').pop();

    return [
      {
        path: file.path,
        rule: this.name,
        severity: this.severity,
        message: `Exploration "${filename}" is cross-cutting (CORPUS root)`,
        suggestion: 'Cross-cutting explorations are allowed. Move to a project if this is project-specific.',
      },
    ];
  },
};
