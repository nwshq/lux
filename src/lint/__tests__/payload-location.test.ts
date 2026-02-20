import { describe, it, expect } from 'vitest';
import { payloadLocation } from '../rules/location/payload-location.js';
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

describe('payload-location', () => {
  const rule = payloadLocation;

  describe('rule metadata', () => {
    it('should have correct name', () => {
      expect(rule.name).toBe('payload-location');
    });

    it('should have error severity', () => {
      expect(rule.severity).toBe('error');
    });
  });

  describe('valid project-scoped payloads (no error)', () => {
    it('should accept payload under project path', () => {
      const file = makeDir(
        'knowledge/10_clients/nwshq/projects/workstream/payloads/2026-02-15-feature/'
      );
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should accept payload under different client/project', () => {
      const file = makeDir('knowledge/10_clients/acme/projects/web-app/payloads/2026-02-15-auth/');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should accept payload without trailing slash', () => {
      const file = makeDir(
        'knowledge/10_clients/nwshq/projects/workstream/payloads/2026-02-15-feature'
      );
      expect(rule.check(file, '/corpus')).toEqual([]);
    });
  });

  describe('payload at CORPUS root (error)', () => {
    it('should error for payload at CORPUS root', () => {
      const file = makeDir('payloads/2026-02-15-feature/');
      const results = rule.check(file, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe('error');
      expect(results[0].rule).toBe('payload-location');
      expect(results[0].message).toContain('CORPUS root');
      expect(results[0].message).toContain('2026-02-15-feature');
    });

    it('should suggest project-scoped location for CORPUS root payload', () => {
      const file = makeDir('payloads/2026-02-15-feature/');
      const results = rule.check(file, '/corpus');
      expect(results[0].suggestion).toContain('knowledge/10_clients/');
    });
  });

  describe('implementation-payloads/ (ignored by isPayloadDir guard)', () => {
    it('should not flag implementation-payloads/ since parent is not "payloads"', () => {
      const file = makeDir('implementation-payloads/2026-02-15-feature/');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });
  });

  describe('invalid non-project-scoped payloads (error)', () => {
    it('should error for payload in arbitrary nested path', () => {
      const file = makeDir('some/random/path/payloads/2026-02-15-idea/');
      const results = rule.check(file, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe('error');
      expect(results[0].message).toContain('not in a valid project location');
    });

    it('should error for payload under knowledge without project structure', () => {
      const file = makeDir('knowledge/10_clients/nwshq/payloads/2026-02-15-feature/');
      const results = rule.check(file, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe('error');
    });
  });

  describe('non-payload paths (ignored)', () => {
    it('should skip files (non-directories)', () => {
      const file = makeFile('payloads/2026-02-15-feature/TASKS.md');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should skip directories not under payloads/', () => {
      const file = makeDir('explorations/2026-02-15-idea');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should skip the payloads/ directory itself', () => {
      const file = makeDir('payloads/');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });
  });
});
