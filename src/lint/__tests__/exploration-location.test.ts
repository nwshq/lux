import { describe, it, expect } from 'vitest';
import { explorationLocation } from '../rules/location/exploration-location.js';
import type { LintFile } from '../types.js';

function makeFile(relativePath: string, overrides?: Partial<LintFile>): LintFile {
  return {
    path: `/corpus/${relativePath}`,
    relativePath,
    isDirectory: false,
    ...overrides,
  };
}

describe('exploration-location', () => {
  const rule = explorationLocation;

  describe('rule metadata', () => {
    it('should have correct name', () => {
      expect(rule.name).toBe('exploration-location');
    });

    it('should have error severity', () => {
      expect(rule.severity).toBe('error');
    });
  });

  describe('valid cross-cutting explorations (no error)', () => {
    it('should accept exploration at CORPUS root', () => {
      const file = makeFile('explorations/2026-02-15-methodology.md');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should accept any .md file directly under explorations/', () => {
      const file = makeFile('explorations/2026-01-10-broad-idea.md');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });
  });

  describe('valid project-scoped explorations (no error)', () => {
    it('should accept exploration under project path', () => {
      const file = makeFile(
        'knowledge/10_clients/nwshq/projects/workstream/explorations/2026-02-15-feature.md'
      );
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should accept exploration under different client/project', () => {
      const file = makeFile(
        'knowledge/10_clients/acme/projects/web-app/explorations/2026-02-15-auth.md'
      );
      expect(rule.check(file, '/corpus')).toEqual([]);
    });
  });

  describe('invalid exploration locations (error)', () => {
    it('should error for exploration in arbitrary nested path', () => {
      const file = makeFile('some/random/path/explorations/2026-02-15-idea.md');
      const results = rule.check(file, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe('error');
      expect(results[0].rule).toBe('exploration-location');
      expect(results[0].message).toContain('not in a valid location');
    });

    it('should error for exploration under knowledge without project structure', () => {
      const file = makeFile(
        'knowledge/10_clients/nwshq/explorations/2026-02-15-feature.md'
      );
      const results = rule.check(file, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe('error');
    });

    it('should include suggestion about valid locations', () => {
      const file = makeFile('some/path/explorations/2026-02-15-idea.md');
      const results = rule.check(file, '/corpus');
      expect(results[0].suggestion).toContain('cross-cutting');
      expect(results[0].suggestion).toContain('project-scoped');
    });

    it('should error for exploration in nested subdirectory of explorations/', () => {
      const file = makeFile('explorations/subdir/2026-02-15-idea.md');
      const results = rule.check(file, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe('error');
    });
  });

  describe('non-exploration files (ignored)', () => {
    it('should skip directories', () => {
      const file = makeFile('explorations/2026-02-15-idea', { isDirectory: true });
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should skip non-markdown files', () => {
      const file = makeFile('explorations/notes.txt');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should skip files not in explorations/', () => {
      const file = makeFile('knowledge/20_methodology/process.md');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should skip payloads directory', () => {
      const file = makeFile('payloads/2026-02-15-feature/TASKS.md');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });
  });
});
