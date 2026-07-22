import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import {
  GIT_REF_GRAMMAR,
  isSafeGitRef,
  assertSafeGitRef,
  getDiffNameStatus,
  getDirtyFileEntries,
  getDirtyFiles,
} from '../git.js';

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: 'pipe' });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init -q');
  git(dir, 'config user.email test@example.com');
  git(dir, 'config user.name Test');
  git(dir, 'config commit.gpgsign false');
}

describe('delta git-safety layer (spec 10 Part A)', () => {
  describe('isSafeGitRef / assertSafeGitRef', () => {
    it('accepts SHAs, origin/main, tags', () => {
      expect(isSafeGitRef('a1b2c3d4e5f6')).toBe(true);
      expect(isSafeGitRef('origin/main')).toBe(true);
      expect(isSafeGitRef('v1.2.3')).toBe(true);
      expect(isSafeGitRef('HEAD~2')).toBe(true);
      expect(isSafeGitRef('HEAD^')).toBe(true);
      expect(isSafeGitRef('release/1.2@stable')).toBe(true);
      // braces are shell metacharacters and outside the grammar (reflog syntax is unsupported).
      expect(isSafeGitRef('feature/x@{0}')).toBe(false);
    });

    it('rejects flag-shaped, metacharacter, and injection refs', () => {
      expect(isSafeGitRef('--output=x')).toBe(false);
      expect(isSafeGitRef('-x')).toBe(false);
      expect(isSafeGitRef(';rm -rf /')).toBe(false);
      expect(isSafeGitRef('$(whoami)')).toBe(false);
      expect(isSafeGitRef('`id`')).toBe(false);
      expect(isSafeGitRef('a b')).toBe(false);
      expect(isSafeGitRef('')).toBe(false);
    });

    it('exposes the grammar and throws on an unsafe ref', () => {
      expect(GIT_REF_GRAMMAR.test('origin/main')).toBe(true);
      expect(GIT_REF_GRAMMAR.test('--output')).toBe(true); // grammar allows chars, but leading '-' is rejected by isSafeGitRef
      expect(() => assertSafeGitRef('--output=/tmp/x')).toThrow(/Unsafe git ref/);
      expect(() => assertSafeGitRef('a1b2c3')).not.toThrow();
    });
  });

  describe('with a real git fixture repo', () => {
    let dir: string;
    beforeEach(() => {
      dir = join(tmpdir(), `lux-delta-git-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      initRepo(dir);
    });
    afterEach(() => {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    });

    it('getDiffNameStatus parses A / M / D and R100 old->new (rename origin)', () => {
      // base commit with a substantial file so the rename is detected by -M similarity.
      const body = Array.from({ length: 40 }, (_, i) => `line ${i} of content`).join('\n');
      writeFileSync(join(dir, 'old.php'), body);
      writeFileSync(join(dir, 'keep.php'), 'keep');
      git(dir, 'add -A');
      git(dir, 'commit -q -m base');
      const base = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();

      // rename old.php -> new.php, add added.php, delete keep.php, modify nothing else.
      git(dir, 'mv old.php new.php');
      writeFileSync(join(dir, 'added.php'), 'new file');
      git(dir, 'rm -q keep.php');
      git(dir, 'add -A');
      git(dir, 'commit -q -m change');

      const entries = getDiffNameStatus(dir, base);
      const rename = entries.find((e) => e.status === 'renamed');
      expect(rename).toBeDefined();
      expect(rename?.path).toBe('new.php');
      expect(rename?.renamedFrom).toBe('old.php');
      expect(entries.find((e) => e.status === 'added')?.path).toBe('added.php');
      expect(entries.find((e) => e.status === 'deleted')?.path).toBe('keep.php');
    });

    it('getDiffNameStatus asserts the base ref (no shell injection)', () => {
      expect(() => getDiffNameStatus(dir, '--output=/tmp/pwn')).toThrow(/Unsafe git ref/);
    });

    it('getDirtyFileEntries recovers rename ORIGIN and tags untracked', () => {
      writeFileSync(join(dir, 'a.php'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      git(dir, 'add -A');
      git(dir, 'commit -q -m base');

      // staged rename a.php -> b.php + an untracked file.
      git(dir, 'mv a.php b.php');
      writeFileSync(join(dir, 'untracked.log'), 'scratch');

      const entries = getDirtyFileEntries(dir);
      const renamed = entries.find((e) => e.status === 'renamed');
      expect(renamed?.path).toBe('b.php');
      expect(renamed?.renamedFrom).toBe('a.php');
      const untracked = entries.find((e) => e.status === 'untracked');
      expect(untracked?.path).toBe('untracked.log');
    });

    it('getDirtyFileEntries keeps the full path for an unstaged-only change (leading-space X column)', () => {
      // ` M a.php` — the first porcelain line's X column is a significant space; the parser must
      // not eat it (regression: a naive full-trim yielded ".php").
      writeFileSync(join(dir, 'a.php'), 'original content here');
      git(dir, 'add -A');
      git(dir, 'commit -q -m base');
      writeFileSync(join(dir, 'a.php'), 'edited content here now');

      const entries = getDirtyFileEntries(dir);
      const modified = entries.find((e) => e.status === 'modified');
      expect(modified?.path).toBe('a.php');
      expect(getDirtyFiles(dir)).toContain('a.php');
    });

    it('getDirtyFiles preserves the string[] contract (regression for overlay-service.ts:98)', () => {
      writeFileSync(join(dir, 'a.php'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      git(dir, 'add -A');
      git(dir, 'commit -q -m base');
      git(dir, 'mv a.php b.php');
      writeFileSync(join(dir, 'scratch.txt'), 'x');

      const files = getDirtyFiles(dir);
      expect(Array.isArray(files)).toBe(true);
      // every element is a plain string (the TARGET path for a rename), matching the old behavior.
      expect(files.every((f) => typeof f === 'string')).toBe(true);
      expect(files).toContain('b.php');
      expect(files).toContain('scratch.txt');
      expect(files).not.toContain('a.php'); // rename target, never the origin
    });
  });
});
