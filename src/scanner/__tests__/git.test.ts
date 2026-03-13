import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { isGitRepository, getHeadCommit, commitExists } from '../git.js';

describe('Git Utilities', () => {
  const testDir = join(tmpdir(), 'lux-git-test-' + Date.now());

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('isGitRepository', () => {
    it('should return false for a plain directory', () => {
      expect(isGitRepository(testDir)).toBe(false);
    });

    it('should return true for a git repository', () => {
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      expect(isGitRepository(testDir)).toBe(true);
    });
  });

  describe('getHeadCommit', () => {
    it('should return a 40-char hex string', () => {
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      writeFileSync(join(testDir, 'README.md'), '# Test');
      execSync('git add -A && git commit -m "init"', { cwd: testDir, stdio: 'pipe' });

      const hash = getHeadCommit(testDir);
      expect(hash).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  describe('commitExists', () => {
    it('should return true for HEAD', () => {
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      writeFileSync(join(testDir, 'README.md'), '# Test');
      execSync('git add -A && git commit -m "init"', { cwd: testDir, stdio: 'pipe' });

      const hash = getHeadCommit(testDir);
      expect(commitExists(testDir, hash)).toBe(true);
    });

    it('should return false for garbage hash', () => {
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      writeFileSync(join(testDir, 'README.md'), '# Test');
      execSync('git add -A && git commit -m "init"', { cwd: testDir, stdio: 'pipe' });

      expect(commitExists(testDir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe(false);
    });
  });
});
