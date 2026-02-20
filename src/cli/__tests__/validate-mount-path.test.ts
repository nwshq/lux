import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { validateMountPath } from '../expert.js';

describe('validateMountPath', () => {
  let corpusDir: string;

  beforeEach(() => {
    corpusDir = mkdtempSync(join(tmpdir(), 'corpus-'));
  });

  afterEach(() => {
    rmSync(corpusDir, { recursive: true, force: true });
  });

  describe('valid mount paths', () => {
    it('should accept a relative path inside CORPUS that exists', () => {
      mkdirSync(join(corpusDir, 'experts'));
      mkdirSync(join(corpusDir, 'experts', 'my-expert'));

      const result = validateMountPath('experts/my-expert', corpusDir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(join(corpusDir, 'experts', 'my-expert'));
      }
    });

    it('should accept an absolute path inside CORPUS that exists', () => {
      mkdirSync(join(corpusDir, 'agents'));
      const absPath = join(corpusDir, 'agents');

      const result = validateMountPath(absPath, corpusDir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(absPath);
      }
    });

    it('should accept CORPUS root itself', () => {
      const result = validateMountPath('.', corpusDir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(corpusDir);
      }
    });

    it('should accept a deeply nested path inside CORPUS', () => {
      mkdirSync(join(corpusDir, 'a', 'b', 'c'), { recursive: true });

      const result = validateMountPath('a/b/c', corpusDir);
      expect(result.ok).toBe(true);
    });
  });

  describe('paths outside CORPUS', () => {
    it('should reject an absolute path outside CORPUS', () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'outside-'));

      const result = validateMountPath(outsideDir, corpusDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('must be inside CORPUS');
        expect(result.error).toContain('outside');
      }

      rmSync(outsideDir, { recursive: true, force: true });
    });

    it('should reject a relative path that traverses out of CORPUS', () => {
      const result = validateMountPath('../../etc', corpusDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('must be inside CORPUS');
      }
    });

    it('should reject a path that starts inside but traverses out', () => {
      mkdirSync(join(corpusDir, 'experts'));

      const result = validateMountPath('experts/../../..', corpusDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('must be inside CORPUS');
      }
    });
  });

  describe('non-existent paths inside CORPUS', () => {
    it('should reject a relative path that does not exist', () => {
      const result = validateMountPath('nonexistent/dir', corpusDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('does not exist');
      }
    });

    it('should reject an absolute path inside CORPUS that does not exist', () => {
      const absPath = join(corpusDir, 'no-such-dir');

      const result = validateMountPath(absPath, corpusDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('does not exist');
      }
    });
  });
});
