import { describe, it, expect } from 'vitest';
import { payloadCorpusLocation } from '../rules/location/payload-corpus-location.js';
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

describe('payload-corpus-location', () => {
  const rule = payloadCorpusLocation;

  describe('rule metadata', () => {
    it('should have correct name', () => {
      expect(rule.name).toBe('payload-corpus-location');
    });

    it('should have error severity', () => {
      expect(rule.severity).toBe('error');
    });
  });

  describe('payload at CORPUS root (error)', () => {
    it('should emit error for payload directory at CORPUS root', () => {
      const file = makeDir('payloads/2026-02-15-feature/');
      const results = rule.check(file, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe('error');
      expect(results[0].rule).toBe('payload-corpus-location');
      expect(results[0].message).toContain('CORPUS root');
      expect(results[0].message).toContain('2026-02-15-feature');
    });

    it('should emit error for payload at CORPUS root without trailing slash', () => {
      const file = makeDir('payloads/2026-02-15-feature');
      const results = rule.check(file, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe('error');
    });

    it('should include suggestion with project-scoped path', () => {
      const file = makeDir('payloads/2026-02-15-feature/');
      const results = rule.check(file, '/corpus');
      expect(results[0].suggestion).toContain('knowledge/10_clients/');
      expect(results[0].suggestion).toContain('2026-02-15-feature');
    });
  });

  describe('payload at project scope (no error)', () => {
    it('should not flag project-scoped payloads', () => {
      const file = makeDir(
        'knowledge/10_clients/nwshq/projects/workstream/payloads/2026-02-15-feature/'
      );
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should not flag deeply nested project payloads', () => {
      const file = makeDir('knowledge/10_clients/acme/projects/web-app/payloads/2026-02-15-auth/');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });
  });

  describe('non-payload paths (ignored)', () => {
    it('should skip files (non-directories)', () => {
      const file = makeFile('payloads/2026-02-15-feature/TASKS.md');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should skip the payloads/ directory itself', () => {
      const file = makeDir('payloads/');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should skip directories not under payloads/', () => {
      const file = makeDir('explorations/2026-02-15-idea');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should skip nested subdirectories within a CORPUS root payload', () => {
      const file = makeDir('payloads/2026-02-15-feature/sub/nested/');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });
  });
});
