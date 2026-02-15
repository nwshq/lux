import { join, relative } from 'path';
import { statSync } from 'fs';
import { glob } from 'glob';
import type { LintFile, LintResult, LintRule } from './types.js';
import { validExplorationFilename } from './rules/naming/valid-exploration-filename.js';
import { validPayloadDirname } from './rules/naming/valid-payload-dirname.js';
import { payloadHasTasks } from './rules/structure/payload-has-tasks.js';
import { explorationLocation } from './rules/location/exploration-location.js';
import { payloadLocation } from './rules/location/payload-location.js';

export type { LintFile, LintResult, LintRule } from './types.js';
export type { Severity } from './types.js';

const DEFAULT_RULES: LintRule[] = [
  // Naming rules
  validExplorationFilename,
  validPayloadDirname,
  // Structure rules
  payloadHasTasks,
  // Location rules
  explorationLocation,
  payloadLocation,
];

export class LintEngine {
  private rules: LintRule[];

  constructor(rules?: LintRule[]) {
    this.rules = rules ?? DEFAULT_RULES;
  }

  async lint(corpusPath: string, targetPath?: string): Promise<LintResult[]> {
    const scanPath = targetPath ?? corpusPath;
    const files = await this.collectFiles(scanPath, corpusPath);
    const results: LintResult[] = [];

    for (const file of files) {
      for (const rule of this.rules) {
        const ruleResults = rule.check(file, corpusPath);
        results.push(...ruleResults);
      }
    }

    return results;
  }

  private async collectFiles(scanPath: string, corpusPath: string): Promise<LintFile[]> {
    const mdFiles = await glob('**/*.md', { cwd: scanPath, nodir: true });
    const dirs = await glob('**/', { cwd: scanPath });

    const files: LintFile[] = [];

    for (const mdFile of mdFiles) {
      const fullPath = join(scanPath, mdFile);
      files.push({
        path: fullPath,
        relativePath: relative(corpusPath, fullPath),
        isDirectory: false,
      });
    }

    for (const dir of dirs) {
      const fullPath = join(scanPath, dir);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          files.push({
            path: fullPath,
            relativePath: relative(corpusPath, fullPath),
            isDirectory: true,
          });
        }
      } catch {
        // Skip inaccessible directories
      }
    }

    return files;
  }
}

export function formatResults(results: LintResult[], corpusPath: string): string {
  if (results.length === 0) {
    return 'No lint issues found.';
  }

  const grouped = new Map<string, LintResult[]>();
  for (const result of results) {
    const relPath = relative(corpusPath, result.path);
    const existing = grouped.get(relPath) ?? [];
    existing.push(result);
    grouped.set(relPath, existing);
  }

  const lines: string[] = [];
  for (const [path, pathResults] of grouped) {
    lines.push(path);
    for (const result of pathResults) {
      lines.push(`  ${result.severity}  ${result.rule}  ${result.message}`);
      if (result.suggestion) {
        lines.push(`    fix: ${result.suggestion}`);
      }
    }
    lines.push('');
  }

  const errors = results.filter((r) => r.severity === 'error').length;
  const warnings = results.filter((r) => r.severity === 'warning').length;

  lines.push(`${errors} error${errors !== 1 ? 's' : ''}, ${warnings} warning${warnings !== 1 ? 's' : ''}`);

  return lines.join('\n');
}
