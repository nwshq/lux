import { describe, it, expect } from 'vitest';
import { validPayloadDirname } from '../rules/naming/valid-payload-dirname.js';
import type { LintFile } from '../types.js';

function makeDir(relativePath: string, overrides?: Partial<LintFile>): LintFile {
  return {
    path: `/corpus/${relativePath}`,
    relativePath,
    isDirectory: true,
    ...overrides,
  };
}

function makeFile(relativePath: string, overrides?: Partial<LintFile>): LintFile {
  return {
    path: `/corpus/${relativePath}`,
    relativePath,
    isDirectory: false,
    ...overrides,
  };
}

describe('valid-payload-dirname', () => {
  const rule = validPayloadDirname;

  describe('rule metadata', () => {
    it('should have correct name', () => {
      expect(rule.name).toBe('valid-payload-dirname');
    });

    it('should have error severity', () => {
      expect(rule.severity).toBe('error');
    });
  });

  describe('valid directory names', () => {
    it('should accept YYYY-MM-DD-slug/', () => {
      const dir = makeDir('payloads/2026-02-12-knowledge-platform');
      expect(rule.check(dir, '/corpus')).toEqual([]);
    });

    it('should accept date with single-word slug', () => {
      const dir = makeDir('payloads/2026-01-15-migration');
      expect(rule.check(dir, '/corpus')).toEqual([]);
    });

    it('should accept date with multi-word slug', () => {
      const dir = makeDir('payloads/2026-02-14-lint-artifact-conventions');
      expect(rule.check(dir, '/corpus')).toEqual([]);
    });

    it('should accept payload in project-scoped payloads/', () => {
      const dir = makeDir('knowledge/10_clients/acme/web-app/payloads/2026-02-14-new-feature');
      expect(rule.check(dir, '/corpus')).toEqual([]);
    });

    it('should accept payload with numbers in slug', () => {
      const dir = makeDir('payloads/2026-02-14-phase-2-rollout');
      expect(rule.check(dir, '/corpus')).toEqual([]);
    });
  });

  describe('invalid directory names', () => {
    it('should reject dirname without date prefix', () => {
      const dir = makeDir('payloads/knowledge-platform');
      const results = rule.check(dir, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe('error');
      expect(results[0].rule).toBe('valid-payload-dirname');
      expect(results[0].message).toContain('knowledge-platform');
      expect(results[0].message).toContain('YYYY-MM-DD');
      expect(results[0].suggestion).toContain('Rename to');
    });

    it('should reject dirname with underscore date separator', () => {
      const dir = makeDir('payloads/2026_02_14-idea');
      const results = rule.check(dir, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].message).toContain('does not match');
    });

    it('should reject dirname with underscore after date', () => {
      const dir = makeDir('payloads/2026-02-14_idea');
      const results = rule.check(dir, '/corpus');
      expect(results).toHaveLength(1);
    });

    it('should reject dirname with no slug after date', () => {
      const dir = makeDir('payloads/2026-02-14');
      const results = rule.check(dir, '/corpus');
      expect(results).toHaveLength(1);
    });

    it('should reject dirname with invalid date (month 13)', () => {
      const dir = makeDir('payloads/2026-13-01-idea');
      const results = rule.check(dir, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].message).toContain('invalid date');
    });

    it('should reject dirname with invalid date (Feb 30)', () => {
      const dir = makeDir('payloads/2026-02-30-idea');
      const results = rule.check(dir, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].message).toContain('invalid date');
    });

    it('should reject dirname with invalid date (day 0)', () => {
      const dir = makeDir('payloads/2026-02-00-idea');
      const results = rule.check(dir, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].message).toContain('invalid date');
    });
  });

  describe('entries to skip', () => {
    it('should skip files (not directories)', () => {
      const file = makeFile('payloads/2026-02-14-idea/TASKS.md');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should skip directories not inside payloads/', () => {
      const dir = makeDir('explorations/2026-02-14-idea');
      expect(rule.check(dir, '/corpus')).toEqual([]);
    });

    it('should skip nested subdirectories within a payload', () => {
      const dir = makeDir('payloads/2026-02-14-idea/sub-dir');
      expect(rule.check(dir, '/corpus')).toEqual([]);
    });

    it('should skip the payloads/ directory itself', () => {
      const dir = makeDir('payloads');
      expect(rule.check(dir, '/corpus')).toEqual([]);
    });
  });

  describe('suggestion quality', () => {
    it('should suggest renaming with today date for dirs without date', () => {
      const dir = makeDir('payloads/cool-feature');
      const results = rule.check(dir, '/corpus');
      expect(results[0].suggestion).toMatch(/Rename to \d{4}-\d{2}-\d{2}-cool-feature\//);
    });

    it('should suggest correct separator for dirs with date but wrong format', () => {
      const dir = makeDir('payloads/2026-02-14_idea');
      const results = rule.check(dir, '/corpus');
      expect(results[0].suggestion).toContain('hyphens, not underscores');
    });
  });
});
