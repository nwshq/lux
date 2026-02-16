import { describe, it, expect } from 'vitest';
import { explorationCorpusLocation } from '../rules/location/exploration-corpus-location.js';
import type { LintFile } from '../types.js';

function makeFile(relativePath: string, overrides?: Partial<LintFile>): LintFile {
  return {
    path: `/corpus/${relativePath}`,
    relativePath,
    isDirectory: false,
    ...overrides,
  };
}

describe('exploration-corpus-location', () => {
  const rule = explorationCorpusLocation;

  describe('rule metadata', () => {
    it('should have correct name', () => {
      expect(rule.name).toBe('exploration-corpus-location');
    });

    it('should have info severity', () => {
      expect(rule.severity).toBe('info');
    });
  });

  describe('cross-cutting explorations (detected)', () => {
    it('should emit info for exploration at CORPUS root', () => {
      const file = makeFile('explorations/2026-02-15-methodology.md');
      const results = rule.check(file, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe('info');
      expect(results[0].rule).toBe('exploration-corpus-location');
      expect(results[0].message).toContain('cross-cutting');
      expect(results[0].message).toContain('2026-02-15-methodology.md');
    });

    it('should emit info for any .md file directly under explorations/', () => {
      const file = makeFile('explorations/2026-01-10-broad-idea.md');
      const results = rule.check(file, '/corpus');
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe('info');
    });

    it('should include suggestion about moving to project if project-specific', () => {
      const file = makeFile('explorations/2026-02-15-methodology.md');
      const results = rule.check(file, '/corpus');
      expect(results[0].suggestion).toContain('project');
    });
  });

  describe('project-scoped explorations (ignored)', () => {
    it('should not flag project-scoped explorations', () => {
      const file = makeFile(
        'knowledge/10_clients/nwshq/projects/workstream/explorations/2026-02-15-feature.md'
      );
      expect(rule.check(file, '/corpus')).toEqual([]);
    });

    it('should not flag deeply nested project explorations', () => {
      const file = makeFile(
        'knowledge/10_clients/acme/projects/web-app/explorations/2026-02-15-auth.md'
      );
      expect(rule.check(file, '/corpus')).toEqual([]);
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

    it('should skip files in nested subdirectories of explorations/', () => {
      const file = makeFile('explorations/subdir/2026-02-15-idea.md');
      expect(rule.check(file, '/corpus')).toEqual([]);
    });
  });
});
