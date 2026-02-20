import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { payloadHasTasks } from '../rules/structure/payload-has-tasks.js';
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

describe('payload-has-tasks', () => {
  const rule = payloadHasTasks;

  describe('rule metadata', () => {
    it('should have correct name', () => {
      expect(rule.name).toBe('payload-has-tasks');
    });

    it('should have error severity', () => {
      expect(rule.severity).toBe('error');
    });
  });

  describe('filesystem checks', () => {
    const tempPath = join(__dirname, 'temp-payload-tasks-fixtures');

    beforeEach(() => {
      mkdirSync(join(tempPath, 'payloads', '2026-02-12-with-tasks'), { recursive: true });
      mkdirSync(join(tempPath, 'payloads', '2026-02-12-without-tasks'), { recursive: true });
      writeFileSync(
        join(tempPath, 'payloads', '2026-02-12-with-tasks', 'TASKS.md'),
        '# Tasks\n- [ ] Task 1'
      );
    });

    afterEach(() => {
      if (existsSync(tempPath)) {
        rmSync(tempPath, { recursive: true, force: true });
      }
    });

    it('should pass when TASKS.md exists', () => {
      const dir: LintFile = {
        path: join(tempPath, 'payloads', '2026-02-12-with-tasks'),
        relativePath: 'payloads/2026-02-12-with-tasks',
        isDirectory: true,
      };
      expect(rule.check(dir, tempPath)).toEqual([]);
    });

    it('should fail when TASKS.md is missing', () => {
      const dir: LintFile = {
        path: join(tempPath, 'payloads', '2026-02-12-without-tasks'),
        relativePath: 'payloads/2026-02-12-without-tasks',
        isDirectory: true,
      };
      const results = rule.check(dir, tempPath);
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe('error');
      expect(results[0].rule).toBe('payload-has-tasks');
      expect(results[0].message).toContain('2026-02-12-without-tasks');
      expect(results[0].message).toContain('TASKS.md');
      expect(results[0].suggestion).toContain('TASKS.md');
    });

    it('should include dirname in suggestion', () => {
      const dir: LintFile = {
        path: join(tempPath, 'payloads', '2026-02-12-without-tasks'),
        relativePath: 'payloads/2026-02-12-without-tasks',
        isDirectory: true,
      };
      const results = rule.check(dir, tempPath);
      expect(results[0].suggestion).toContain('2026-02-12-without-tasks/TASKS.md');
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

  describe('project-scoped payloads', () => {
    const tempPath = join(__dirname, 'temp-payload-tasks-scoped');

    beforeEach(() => {
      mkdirSync(join(tempPath, 'knowledge/10_clients/acme/web-app/payloads/2026-02-14-feature'), {
        recursive: true,
      });
    });

    afterEach(() => {
      if (existsSync(tempPath)) {
        rmSync(tempPath, { recursive: true, force: true });
      }
    });

    it('should check project-scoped payload directories', () => {
      const dir: LintFile = {
        path: join(tempPath, 'knowledge/10_clients/acme/web-app/payloads/2026-02-14-feature'),
        relativePath: 'knowledge/10_clients/acme/web-app/payloads/2026-02-14-feature',
        isDirectory: true,
      };
      const results = rule.check(dir, tempPath);
      expect(results).toHaveLength(1);
      expect(results[0].message).toContain('TASKS.md');
    });

    it('should pass for project-scoped payload with TASKS.md', () => {
      writeFileSync(
        join(tempPath, 'knowledge/10_clients/acme/web-app/payloads/2026-02-14-feature', 'TASKS.md'),
        '# Tasks'
      );

      const dir: LintFile = {
        path: join(tempPath, 'knowledge/10_clients/acme/web-app/payloads/2026-02-14-feature'),
        relativePath: 'knowledge/10_clients/acme/web-app/payloads/2026-02-14-feature',
        isDirectory: true,
      };
      expect(rule.check(dir, tempPath)).toEqual([]);
    });
  });
});
