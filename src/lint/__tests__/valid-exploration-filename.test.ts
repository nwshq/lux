import { describe, it, expect } from 'vitest';
import { validExplorationFilename } from '../rules/naming/valid-exploration-filename.js';
import type { LintFile } from '../types.js';

function makeFile(relativePath: string, overrides?: Partial<LintFile>): LintFile {
  return {
    path: `/corpus/${relativePath}`,
    relativePath,
    isDirectory: false,
    ...overrides,
  };
}

describe('valid-exploration-filename', () => {
  const rule = validExplorationFilename;

  describe('rule metadata', () => {
    it('should have correct name', () => {
      expect(rule.name).toBe('valid-exploration-filename');
    });

    it('should have error severity', () => {
      expect(rule.severity).toBe('error');
    });
  });

  describe('valid filenames', () => {
    it('should accept YYYY-MM-DD-slug.md', () => {
      const file = makeFile('explorations/2026-02-11-knowledge-platform.md');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should accept date with single-word slug', () => {
      const file = makeFile('explorations/2026-01-15-idea.md');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should accept date with multi-word slug', () => {
      const file = makeFile('explorations/2026-02-14-write-layer.md');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should accept exploration in project-scoped explorations/', () => {
      const file = makeFile(
        'knowledge/10_clients/acme/web-app/explorations/2026-02-14-new-feature.md'
      );
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should accept exploration with numbers in slug', () => {
      const file = makeFile('explorations/2026-02-14-phase-2-rollout.md');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });
  });

  describe('invalid filenames', () => {
    it('should reject filename without date prefix', () => {
      const file = makeFile('explorations/my-idea.md');
      const results = rule.check(file, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe('error');
      expect(results[0].rule).toBe('valid-exploration-filename');
      expect(results[0].message).toContain('my-idea.md');
      expect(results[0].message).toContain('YYYY-MM-DD');
      expect(results[0].suggestion).toContain('Rename to');
    });

    it('should reject filename with underscore date separator', () => {
      const file = makeFile('explorations/2026_02_14-idea.md');
      const results = rule.check(file, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].message).toContain('does not match');
    });

    it('should reject filename with underscore after date', () => {
      const file = makeFile('explorations/2026-02-14_idea.md');
      const results = rule.check(file, '/corpus');
      expect(results).toHaveLength(1);
    });

    it('should reject filename with no slug after date', () => {
      const file = makeFile('explorations/2026-02-14.md');
      const results = rule.check(file, '/corpus');
      expect(results).toHaveLength(1);
    });

    it('should reject filename with invalid date (month 13)', () => {
      const file = makeFile('explorations/2026-13-01-idea.md');
      const results = rule.check(file, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].message).toContain('invalid date');
    });

    it('should reject filename with invalid date (Feb 30)', () => {
      const file = makeFile('explorations/2026-02-30-idea.md');
      const results = rule.check(file, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].message).toContain('invalid date');
    });

    it('should reject filename with invalid date (day 0)', () => {
      const file = makeFile('explorations/2026-02-00-idea.md');
      const results = rule.check(file, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].message).toContain('invalid date');
    });
  });

  describe('files to skip', () => {
    it('should skip directories', () => {
      const file = makeFile('explorations/2026-02-14-idea', { isDirectory: true });
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should skip non-markdown files', () => {
      const file = makeFile('explorations/notes.txt');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should skip files not in explorations/ directory', () => {
      const file = makeFile('knowledge/20_methodology/my-process.md');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should skip files in communications/', () => {
      const file = makeFile('knowledge/10_clients/acme/communications/2026-02-14_meeting.md');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });
  });

  describe('suggestion quality', () => {
    it('should suggest renaming with today date for files without date', () => {
      const file = makeFile('explorations/cool-idea.md');
      const results = rule.check(file, '/corpus');
      expect(results[0].suggestion).toMatch(/Rename to \d{4}-\d{2}-\d{2}-cool-idea\.md/);
    });

    it('should suggest correct separator for files with date but wrong format', () => {
      const file = makeFile('explorations/2026-02-14_idea.md');
      const results = rule.check(file, '/corpus');
      expect(results[0].suggestion).toContain('hyphens, not underscores');
    });
  });
});
