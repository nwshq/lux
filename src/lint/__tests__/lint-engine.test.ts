import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { LintEngine, formatResults } from '../index.js';

describe('LintEngine', () => {
  const tempPath = join(__dirname, 'temp-lint-fixtures');

  beforeEach(() => {
    mkdirSync(join(tempPath, 'explorations'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempPath)) {
      rmSync(tempPath, { recursive: true, force: true });
    }
  });

  describe('lint()', () => {
    it('should return only info for valid cross-cutting explorations', async () => {
      writeFileSync(
        join(tempPath, 'explorations/2026-02-14-valid-idea.md'),
        '# Valid Idea'
      );

      const engine = new LintEngine();
      const results = await engine.lint(tempPath);
      const errors = results.filter((r) => r.severity === 'error');
      expect(errors).toEqual([]);
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe('info');
      expect(results[0].rule).toBe('exploration-corpus-location');
    });

    it('should return errors for invalid exploration filenames', async () => {
      writeFileSync(
        join(tempPath, 'explorations/bad-name.md'),
        '# Bad Name'
      );

      const engine = new LintEngine();
      const results = await engine.lint(tempPath);
      const errors = results.filter((r) => r.severity === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0].rule).toBe('valid-exploration-filename');
      expect(errors[0].severity).toBe('error');
    });

    it('should check both valid and invalid files', async () => {
      writeFileSync(
        join(tempPath, 'explorations/2026-02-14-good.md'),
        '# Good'
      );
      writeFileSync(
        join(tempPath, 'explorations/bad.md'),
        '# Bad'
      );

      const engine = new LintEngine();
      const results = await engine.lint(tempPath);
      const errors = results.filter((r) => r.severity === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('bad.md');
    });

    it('should lint a specific target path', async () => {
      mkdirSync(join(tempPath, 'other'), { recursive: true });
      writeFileSync(join(tempPath, 'explorations/bad.md'), '# Bad');
      writeFileSync(join(tempPath, 'other/also-bad.md'), '# Also Bad');

      const engine = new LintEngine();
      const results = await engine.lint(tempPath, join(tempPath, 'explorations'));
      // Should only find the exploration file, not the other directory
      const errors = results.filter((r) => r.severity === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('bad.md');
    });

    it('should check project-scoped explorations', async () => {
      const projectExplorations = join(
        tempPath,
        'knowledge/10_clients/acme/projects/web-app/explorations'
      );
      mkdirSync(projectExplorations, { recursive: true });
      writeFileSync(join(projectExplorations, 'missing-date.md'), '# Missing');

      const engine = new LintEngine();
      const results = await engine.lint(tempPath);
      const errors = results.filter((r) => r.severity === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('missing-date.md');
    });

    it('should handle empty corpus', async () => {
      const engine = new LintEngine();
      const results = await engine.lint(tempPath);
      expect(results).toEqual([]);
    });
  });

  describe('custom rules', () => {
    it('should accept custom rules via constructor', async () => {
      writeFileSync(
        join(tempPath, 'explorations/2026-02-14-test.md'),
        '# Test'
      );

      const customRule = {
        name: 'custom-rule',
        description: 'A custom rule',
        severity: 'warning' as const,
        check() {
          return [
            {
              path: 'test',
              rule: 'custom-rule',
              severity: 'warning' as const,
              message: 'Custom warning',
            },
          ];
        },
      };

      const engine = new LintEngine([customRule]);
      const results = await engine.lint(tempPath);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.rule === 'custom-rule')).toBe(true);
    });
  });
});

describe('formatResults', () => {
  it('should format empty results', () => {
    expect(formatResults([], '/corpus')).toBe('No lint issues found.');
  });

  it('should format results grouped by file', () => {
    const results = [
      {
        path: '/corpus/explorations/bad.md',
        rule: 'valid-exploration-filename',
        severity: 'error' as const,
        message: 'Bad filename',
        suggestion: 'Rename it',
      },
    ];

    const output = formatResults(results, '/corpus');
    expect(output).toContain('explorations/bad.md');
    expect(output).toContain('error');
    expect(output).toContain('Bad filename');
    expect(output).toContain('fix: Rename it');
    expect(output).toContain('1 error');
  });

  it('should count errors and warnings separately', () => {
    const results = [
      {
        path: '/corpus/a.md',
        rule: 'r1',
        severity: 'error' as const,
        message: 'Error',
      },
      {
        path: '/corpus/b.md',
        rule: 'r2',
        severity: 'warning' as const,
        message: 'Warning',
      },
      {
        path: '/corpus/c.md',
        rule: 'r3',
        severity: 'error' as const,
        message: 'Error 2',
      },
    ];

    const output = formatResults(results, '/corpus');
    expect(output).toContain('2 errors, 1 warning');
  });

  it('should include info count when present', () => {
    const results = [
      {
        path: '/corpus/a.md',
        rule: 'r1',
        severity: 'error' as const,
        message: 'Error',
      },
      {
        path: '/corpus/b.md',
        rule: 'r2',
        severity: 'info' as const,
        message: 'Info',
      },
    ];

    const output = formatResults(results, '/corpus');
    expect(output).toContain('1 error, 0 warnings, 1 info');
  });

  it('should omit info count when zero', () => {
    const results = [
      {
        path: '/corpus/a.md',
        rule: 'r1',
        severity: 'error' as const,
        message: 'Error',
      },
    ];

    const output = formatResults(results, '/corpus');
    expect(output).not.toContain('info');
  });
});
